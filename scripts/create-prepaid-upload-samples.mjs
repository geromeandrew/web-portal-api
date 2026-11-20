import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { datasetSchemas, expectedName } from '../src/modules/prepaid/domain/contracts.ts';

// Generates synthetic artifacts only. No database, S3 or AWS operations.
const folder=resolve(process.argv[2] || 'C:/Users/rccco/Downloads/Prepaid-Reclass-Samples-2026-09');
const archive=folder+'.zip';
if(existsSync(folder)||existsSync(archive)) throw Error('Sample destination already exists; refusing to overwrite it.');
const period='2026-09', cycles=['01','02'];
const base={period,brand:'GP',cfu:'CM',revenue_type:'MT',cost_element:'123',sub_product:'SUB',uom:'EA',reference_document:'1',quantity:'10',currency:'PHP'};
const datasets={
  ke24:[{...base,cfu:'EG',profit_center:'P1',amount:'-100'},{...base,brand:'HY',cfu:'EG',profit_center:'P1',amount:'-50'},{...base,profit_center:'P1',amount:'60'},{...base,profit_center:'P2',amount:'40'}],
  callcard:['eg','sg'].flatMap(region=>['trade','internal'].map(kind=>({period,region,kind,month_no:9,amount:'0'}))),
  loadup:[{period,region:'eg',amount:'224'},{period,region:'sg',amount:'0'}],
  loadapi:[{period,region:'eg',amount:'0'},{period,region:'sg',amount:'0'}],
  recharge:[{period,customer_type:'E',method:'PS',channel:'RP',amount:'56'},{period,customer_type:'S',method:'PS',channel:'RP',amount:'0'}],
  adjustments:cycles.map(cycle=>({period,cycle,customer_type:'E',code:'AMAXCEP',amount:cycle==='01'?'-10':'0',currency:'PHP'})),
  charges:cycles.map(cycle=>({period,cycle,customer_type:'E',code:'AMAXCEP',amount:cycle==='02'?'66':'0',currency:'PHP'})),
  reference:[{period,client:'300',company:'GLOB',cost_element:'123',brand:'GP',cfu:'CM',revenue_type:'MT',sub_product:'SUB',tax_rate:'0.12',average_rate:'10',uom:'EA'}],
};
for(const [name,rows] of Object.entries(datasets)) for(const row of rows) datasetSchemas[name].parse(row);
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function column(i){let result='';do{result=String.fromCharCode(65+i%26)+result;i=Math.floor(i/26)-1;}while(i>=0);return result;}
function workbook(rows, sheetName='Data'){
  let values=rows;
  if(!Array.isArray(rows[0])){
    const headers=Object.keys(rows[0]);
    values=[headers,...rows.map(row=>headers.map(field=>row[field]))];
  }
  const dimension=`A1:${column(Math.max(...values.map(row=>row.length))-1)}${values.length}`;
  const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="'+dimension+'"/><sheetData>'+values.map((row,i)=>`<row r="${i+1}">`+row.map((v,j)=>`<c r="${column(j)}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>';
  const parts={
    '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheet,
  };
  const bytes=zipSync(Object.fromEntries(Object.entries(parts).map(([name,text])=>[name,strToU8(text)])));
  if(!unzipSync(bytes)['xl/worksheets/sheet1.xml']) throw Error('Invalid workbook archive');
  return bytes;
}
const files={};
function xlsx(code,rows,sheetName){files['uploads/'+expectedName(code)]=workbook(rows,sheetName);}
xlsx('ke24',datasets.ke24);
for(const region of ['eg','sg']){
  xlsx('callcard_'+region,region==='sg'
    ? [['Synthetic Call Card SG'],['September 2026'],['PHP'],['Month','Trade','','','','','Internal'],['September 2026','0','','','','','0']]
    : datasets.callcard.filter(r=>r.region===region),region==='sg'?'CALLCARD':'Data');
  xlsx('load_up_'+region,datasets.loadup.filter(r=>r.region===region));
  xlsx('load_api_'+region,region==='eg'
    ? [['Synthetic Load API EG'],['September 2026'],['Type','App ID','Wallet ID','Company Name','Dev Email','Top up Amount'],['EG','','','','','0']]
    : [['Synthetic Load API SG - September 2026'],['Type','Transactional Discount','App ID','Wallet ID','Company Name','Dev Email','Top up Amount','TOP UP Date','OR Number'],['SG','','','','','','','','0']]);
}
const fields=Object.keys(datasets.recharge[0]);
files['uploads/'+expectedName('monthly_recharge')]=strToU8([fields.join(','),...datasets.recharge.map(row=>fields.map(f=>row[f]).join(','))].join('\r\n')+'\r\n');
for(const cycle of cycles){
  const adjustment=datasets.adjustments.find(r=>r.cycle===cycle);
  xlsx('308_'+cycle,[['Cycle Code:',cycle],['Cycle Year:','2026'],['Cycle Instance:','9'],[],
    ['Customer Type','Customer Sub Type','Subscriber Type','Adjustment Type','Adjustment Code','Adjustment Reason','Legal Entity','Currency','Amount','Write-Off Activity Indicator'],
    [adjustment.customer_type,'TEST','Prepaid','Credit',adjustment.code,'Synthetic UI test','GLOB','PHP',adjustment.amount,'N']]);
  xlsx('318_'+cycle,datasets.charges.filter(r=>r.cycle===cycle));
}
for(const [name,rows] of Object.entries(datasets)) files['adapter-fixtures/'+name+'.jsonl']=strToU8(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
files['README.md']=strToU8(`# Prepaid Re-Class sample upload pack

Synthetic test data only. Accounting period: September 2026 (2026-09). Billing cycles: 01 and 02. Currency: PHP. SG values are intentionally zero. No real customer or production financial data is included.

## What to upload

Upload the 12 files in the uploads folder individually or select all 12. Do not upload this ZIP, README, or adapter-fixtures folder. Keep exact filenames. The pack includes KE24; EG/SG Call Card, Load Up and Load API; monthly recharge CSV; and 308/318 reports for both cycles.

## Important: these files do not bypass configuration

The local database currently has no Prepaid integration configuration. Upload is blocked until an administrator configures a real ingestion adapter, expectedCycles ["01","02"], and an approved report format. Automatic SAP delivery is not required by the current manual-staging implementation.

These are genuine Excel OOXML workbooks and CSV. Call Card SG, Load API EG/SG and 308 use the layouts implemented in infrastructure/prepaid/portal_source_extract.py, including the CALLCARD sheet, positional amount columns, and 308 cycle evidence and ten detail headings. The remaining source families use canonical field names because a complete V2 ingestion adapter is still a separate dependency. They are synthetic contract inputs, not certified legacy reports or proof of a complete accounting run. The portal extraction branch writes isolated S3 artifacts, not the shared billed_adjustments raw tables.

## For the ingestion-adapter developer

adapter-fixtures contains eight schema-validated canonical JSONL datasets corresponding to the sample inputs. reference.jsonl is a synthetic SAP mapping for this test data, not an upload and not a production mapping. Reference data is a backend adapter dependency. Do not put fake approved mappings into production.

Implement the version-2 upload-session contract defined by the Prepaid upload-session API. The adapter must verify source hashes and derive the period from KE24. Do not copy session UUIDs, source IDs, checksums, execution ARNs or manifests from examples; compute them for the actual execution.

No database configuration or data was changed to generate this pack. No S3 upload, AWS execution or SAP posting was performed.
`);
mkdirSync(folder,{recursive:false});mkdirSync(join(folder,'uploads'));mkdirSync(join(folder,'adapter-fixtures'));
for(const [name,bytes] of Object.entries(files))writeFileSync(join(folder,name),bytes,{flag:'wx'});
writeFileSync(archive,zipSync(files),{flag:'wx'});
console.log(JSON.stringify({folder,archive,uploadFiles:12,workbooks:11,csvFiles:1,canonicalFixtures:8,period,cycles,validated:true},null,2));

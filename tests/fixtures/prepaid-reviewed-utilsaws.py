import boto3
import os
import time
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from urllib.parse import urlparse

def move_s3_file(src_url, dest_url, delete_original=True):

    """ 
    **Moves or Copies an S3 file using boto3. 
    Skips if destination is blank or file is missing.
    If delete_original=False, it performs a Copy-Only operation.
    """

    if not src_url or not dest_url:
        return
        
    operation_type = "Move" if delete_original else "Copy-Only"
    print(f"### -Attempting to {operation_type} file from {src_url} to {dest_url}")
    try:
        s3 = boto3.client('s3')
        src_parsed = urlparse(src_url)
        dest_parsed = urlparse(dest_url)
        
        src_bucket, src_key = src_parsed.netloc, src_parsed.path.lstrip('/')
        dest_bucket, dest_key = dest_parsed.netloc, dest_parsed.path.lstrip('/')
        
        # check if the file actually exists before trying to move it
        try:
            s3.head_object(Bucket=src_bucket, Key=src_key)

        except Exception:
            error_msg = f"Source file does not exist in S3. Skipping {operation_type} operation."
            print(f"### -{error_msg}")
            raise Exception(error_msg) # raise it so the main script catches it as a cascading failure
            
        # perform Copy
        s3.copy_object(Bucket=dest_bucket, Key=dest_key, CopySource={'Bucket': src_bucket, 'Key': src_key})
        
        # conditionally Delete (S3 Native Move)
        if delete_original:
            s3.delete_object(Bucket=src_bucket, Key=src_key)
            print("### -File successfully moved to processed path (Original Deleted).")
        else:
            print("### -File successfully copied to processed path (Original Retained).")
        
    except Exception as e:
        error_msg = f"Failed to {operation_type} file to error path. Reason: {str(e)}"
        print(f"### -Warning: {error_msg}")
        
        raise Exception(error_msg) # raise it so the main script catches it as a cascading failure


def backup_df_to_s3_csv(df, s3_dir_path, custom_filename, max_retries=5, initial_delay=2.0):

    """
    **Writes a PySpark DataFrame to S3 as a single CSV file w/custom filename.
    Includes a smart retry mechanism to eliminate race conditions caused by S3 indexing delays.

    :param df: PySpark DataFrame to save.
    :param s3_dir_path: Destination S3 directory URI (e.g., 's3://bucket-globe/bss_billcycle_bayn/_logs-transform').
    :param custom_filename: Desired final output filename (e.g., 'Job_Name_12345678_success').
    :param max_retries: Maximum number of retry attempts to locate the generated CSV part file.
    :param initial_delay: Time in seconds to wait before the first retry attempt.
    """
    # Clean up S3 directory path
    s3_dir_path = s3_dir_path.rstrip('/')
    
    # Parse S3 Bucket and Prefix
    parsed_url = urlparse(s3_dir_path)
    bucket_name = parsed_url.netloc
    base_prefix = parsed_url.path.lstrip('/')
    
    # Ensure custom_filename ends with .csv
    target_filename = custom_filename if custom_filename.lower().endswith('.csv') else f"{custom_filename}.csv"
    
    # Generate unique temporary directory name for Spark execution
    temp_dir_name = f"_temp_{custom_filename}_{int(time.time() * 1000)}"
    temp_s3_path = f"{s3_dir_path}/{temp_dir_name}"
    temp_prefix = f"{base_prefix}/{temp_dir_name}" if base_prefix else temp_dir_name

    print(f"### [UtilsAWS] Writing temporary Spark output to: {temp_s3_path}")
    
    # 1. Force single partition write to ensure only ONE part-*.csv is created
    df.coalesce(1).write.mode("overwrite").option("header", "true").csv(temp_s3_path)
    
    s3_client = boto3.client('s3')
    part_file_key = None
    delay = initial_delay
    
    # 2. Smart Retry Loop for S3 Listing & Indexing Delays
    print(f"### [UtilsAWS] Searching for generated part file in 's3://{bucket_name}/{temp_prefix}'...")
    for attempt in range(1, max_retries + 1):
        try:
            response = s3_client.list_objects_v2(
                Bucket=bucket_name,
                Prefix=temp_prefix
            )
            
            contents = response.get('Contents', [])
            
            # Find the part-*.csv file (ignoring _SUCCESS metadata files)
            for obj in contents:
                key = obj['Key']
                filename = key.split('/')[-1]
                if filename.startswith('part-') and '.csv' in filename:
                    part_file_key = key
                    break
            
            if part_file_key:
                print(f"### [UtilsAWS] Found part file on attempt #{attempt}: {part_file_key}")
                break
        except Exception as e:
            print(f"### [UtilsAWS] Warning on S3 listing attempt #{attempt}: {str(e)}")
        
        print(f"### [UtilsAWS] Part file not visible yet on attempt #{attempt}/{max_retries}. Retrying in {delay}s...")
        time.sleep(delay)
        delay *= 1.5  # Progressive backoff delay

    # 3. Validation Guard Clause
    if not part_file_key:
        target_s3_full_path = f"{s3_dir_path}/{target_filename}"
        raise Exception(
            f"Procedure Export Error: Failed to write CSV backup to S3 path {target_s3_full_path}. "
            f"Reason: Spark successfully wrote to S3, but no .csv part file was generated in '{temp_prefix}' after {max_retries} attempts."
        )

    # 4. Copy part-*.csv to final S3 destination with the exact custom filename
    target_key = f"{base_prefix}/{target_filename}" if base_prefix else target_filename
    print(f"### [UtilsAWS] Renaming part file to target destination: 's3://{bucket_name}/{target_key}'...")
    
    s3_client.copy_object(
        Bucket=bucket_name,
        CopySource={'Bucket': bucket_name, 'Key': part_file_key},
        Key=target_key
    )

    # 5. Cleanup temporary Spark folder
    print(f"### [UtilsAWS] Cleaning up temporary directory '{temp_prefix}'...")
    try:
        temp_objects = s3_client.list_objects_v2(Bucket=bucket_name, Prefix=temp_prefix)
        if 'Contents' in temp_objects:
            delete_keys = [{'Key': obj['Key']} for obj in temp_objects['Contents']]
            s3_client.delete_objects(
                Bucket=bucket_name,
                Delete={'Objects': delete_keys}
            )
    except Exception as cleanup_err:
        print(f"### [UtilsAWS] Warning: Failed to clean up temp files: {str(cleanup_err)}")

    print(f"### [UtilsAWS] Backup successfully created at: s3://{bucket_name}/{target_key}")
    

def export_df_to_exact_filename(df, s3_dir_path, exact_filename, delimiter="\t", include_header=True):

    """
    **Coalesces and writes a PySpark DataFrame to S3 using a custom delimiter,
    then uses boto3 to rename it to the EXACT filename provided (e.g., .txt, .csv, .dat).
    include_header: when False, writes data rows only (no column-name header line).
    """
    # ensure dir path ends w/a slash
    if not s3_dir_path.endswith('/'):
        s3_dir_path += '/'
        
    temp_dir = s3_dir_path + "temp_spark_output/"
    final_file_path = s3_dir_path + exact_filename
    header_flag = "true" if include_header else "false"

    print(f"### - Attempting to write custom extract to S3 at: {final_file_path} (header={header_flag})")

    try:
        # spark write random part-file using custom delimiter.
        # Default Spark CSV quotes empty strings as "". Use a NUL quote char
        # (quote="" is unreliable on some Glue/Spark builds and can drop values
        # like 00/01/99) and emit truly empty fields for legacy TSV load files.
        df.coalesce(1).write \
            .mode("overwrite") \
            .option("header", header_flag) \
            .option("delimiter", delimiter) \
            .option("quote", "\u0000") \
            .option("escape", "\u0000") \
            .option("emptyValue", "") \
            .option("nullValue", "") \
            .csv(temp_dir)
            
        # use boto3 to find actual file & rename it
        s3 = boto3.client('s3')
        parsed_url = urlparse(temp_dir)
        bucket = parsed_url.netloc
        prefix = parsed_url.path.lstrip('/')
        
        response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        
        part_file_key = None
        for obj in response.get('Contents', []):
            if obj['Key'].endswith('.csv'):  # spark always creates .csv parts
                part_file_key = obj['Key']
                break
                
        if part_file_key:
            final_key = urlparse(final_file_path).path.lstrip('/')
            
            # copy file to new path w/exact custom name
            s3.copy_object(
                Bucket=bucket, 
                Key=final_key, 
                CopySource={'Bucket': bucket, 'Key': part_file_key}
            )
            
            # this in now cleanup only, delete temporary spark dir & its contents
            for obj in response.get('Contents', []):
                s3.delete_object(Bucket=bucket, Key=obj['Key'])
                
            print(f"### - SUCCESS: S3 file renamed and safely stored as {exact_filename}.")
            
        else:
            raise Exception("Spark successfully wrote to S3, but no part file was generated.")

    except Exception as e:
        error_msg = f"Failed to write extract to S3 path {final_file_path}. Reason: {str(e)}"
        print(f"### - CRITICAL S3 ERROR: {error_msg}")
        
        # raise exception so the main runner script catches it
        raise Exception(error_msg)


def _xlsx_cell(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value
    return value


def export_df_to_xlsx(df, s3_dir_path, exact_filename):
    """Write a real Office Open XML workbook (openpyxl) to S3.

    Spark CSV + rename-to-.xlsx is not a valid workbook; Excel rejects it.
    """
    from openpyxl import Workbook

    if not s3_dir_path.endswith("/"):
        s3_dir_path += "/"
    final_file_path = s3_dir_path + exact_filename
    print(f"### - Attempting to write xlsx extract to S3 at: {final_file_path}")

    try:
        columns = df.columns
        rows = df.collect()
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(list(columns))
        for row in rows:
            sheet.append([_xlsx_cell(value) for value in row])

        buffer = BytesIO()
        workbook.save(buffer)
        parsed = urlparse(final_file_path)
        boto3.client("s3").put_object(
            Bucket=parsed.netloc,
            Key=parsed.path.lstrip("/"),
            Body=buffer.getvalue(),
            ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        print(f"### - SUCCESS: S3 xlsx stored as {exact_filename} ({len(rows)} data rows).")
    except Exception as e:
        error_msg = f"Failed to write xlsx to S3 path {final_file_path}. Reason: {str(e)}"
        print(f"### - CRITICAL S3 ERROR: {error_msg}")
        raise Exception(error_msg)


def resolve_s3_case_insensitivity(s3_uri):
    """
    Checks S3 for a file matching the target URI regardless of case.
    If multiple case-variations exist, returns the most recently modified one.
    """
    parsed = urlparse(s3_uri)
    bucket = parsed.netloc
    expected_key = parsed.path.lstrip('/')
    
    s3_client = boto3.client('s3')
    folder = os.path.dirname(expected_key)
    if folder:
        folder += '/'
        
    try:
        # List all files in the target inbound directory
        response = s3_client.list_objects_v2(Bucket=bucket, Prefix=folder)
        if 'Contents' in response:
            
            # 1. Create an empty list to hold any files that match the name
            matching_objects = []
            
            for obj in response['Contents']:
                # 2. If it's a case-insensitive match, add the whole S3 object dictionary to our list
                if obj['Key'].lower() == expected_key.lower():
                    matching_objects.append(obj)
            
            if matching_objects:
                # 3. Sort the matched objects by their 'LastModified' datetime (newest first)
                matching_objects.sort(key=lambda x: x['LastModified'], reverse=True)
                
                # 4. Grab the 'Key' (filename) of the very first item in the sorted list
                latest_key = matching_objects[0]['Key']
                
                # Return the TRUE case-sensitive path of the newest file
                return f"s3://{bucket}/{latest_key}"
                
    except Exception as e:
        print(f"### -Warning: S3 resolution failed: {str(e)}")
        
    # If not found, return the original string so PySpark's normal error handling catches it
    return s3_uri
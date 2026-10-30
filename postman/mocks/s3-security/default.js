// Local-only subset of S3 REST: never validates AWS IAM or contacts AWS.
const http = require("node:http");
const { createHash } = require("node:crypto");
const s3Objects = new Map();
const xml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
function error(res, status, code) {
  res.writeHead(status, { "Content-Type": "application/xml" });
  res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}
function read(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function decodeChunks(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const end = body.indexOf("\r\n", offset);
    if (end < 0) throw Error("Invalid chunk");
    const size = parseInt(
      body.subarray(offset, end).toString().split(";")[0],
      16,
    );
    if (!Number.isFinite(size)) throw Error("Invalid chunk");
    if (!size) break;
    chunks.push(body.subarray(end + 2, end + 2 + size));
    offset = end + 2 + size + 2;
  }
  return Buffer.concat(chunks);
}
http
  .createServer(async (req, res) => {
    try {
      const bodyPromise = read(req);
      const url = new URL(req.url, "http://s3.test");
      const parts = url.pathname.slice(1).split("/");
      const bucket = decodeURIComponent(parts.shift());
      const key = parts.map(decodeURIComponent).join("/");
      const id = `${bucket}/${key}`;
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        await bodyPromise;
        const prefix = url.searchParams.get("prefix") || "";
        const start = Number(url.searchParams.get("continuation-token") || 0);
        const max = Math.min(
          1000,
          Number(url.searchParams.get("max-keys") || 1000),
        );
        const all = [...s3Objects.entries()]
          .filter(([k]) => k.startsWith(`${bucket}/${prefix}`))
          .sort(([a], [b]) => a.localeCompare(b));
        const selected = all.slice(start, start + max);
        const more = start + max < all.length;
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${selected.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""}${selected.map(([k, o]) => `<Contents><Key>${xml(k.slice(bucket.length + 1))}</Key><LastModified>${o.time}</LastModified><ETag>${xml(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")}</ListBucketResult>`,
        );
      }
      if (req.method === "PUT" && key) {
        let body = await bodyPromise;
        if (req.headers["x-amz-copy-source"]) {
          const from = decodeURIComponent(
            req.headers["x-amz-copy-source"],
          ).replace(/^\//, "");
          const source = s3Objects.get(from);
          if (!source) return error(res, 404, "NoSuchKey");
          body = Buffer.from(source.body);
        }
        if (req.headers["if-none-match"] === "*" && s3Objects.has(id))
          return error(res, 412, "PreconditionFailed");
        if (String(req.headers["content-encoding"]).includes("aws-chunked"))
          body = decodeChunks(body);
        const entry = {
          body,
          time: new Date().toISOString(),
          etag: `"${createHash("md5").update(body).digest("hex")}"`,
          type: req.headers["content-type"] || "application/octet-stream",
        };
        s3Objects.set(id, entry);
        res.writeHead(200, {
          ETag: entry.etag,
          "Content-Type": "application/xml",
        });
        return res.end(
          req.headers["x-amz-copy-source"]
            ? `<CopyObjectResult><LastModified>${entry.time}</LastModified><ETag>${xml(entry.etag)}</ETag></CopyObjectResult>`
            : "",
        );
      }
      await bodyPromise;
      if (req.method === "GET" || req.method === "HEAD") {
        const entry = s3Objects.get(id);
        if (!entry) return error(res, 404, "NoSuchKey");
        res.writeHead(200, {
          "Content-Type": entry.type,
          "Content-Length": entry.body.length,
          "Last-Modified": new Date(entry.time).toUTCString(),
          ETag: entry.etag,
        });
        return res.end(req.method === "HEAD" ? undefined : entry.body);
      }
      if (req.method === "DELETE" && key) {
        s3Objects.delete(id);
        res.writeHead(204);
        return res.end();
      }
      error(res, 501, "NotImplemented");
    } catch {
      if (!res.headersSent) error(res, 500, "InternalError");
      else res.destroy();
    }
  })
  .listen(process.env.PORT || 4500, "127.0.0.1");

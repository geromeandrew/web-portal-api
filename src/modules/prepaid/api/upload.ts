import multer from "multer";
import type { RequestHandler } from "express";
import { AppError } from "../../../errors.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";

/** Bound concurrent in-memory Prepaid uploads without widening other modules. */
export function createPrepaidUpload(
  maximumBytes = prepaidMaximumSourceBytes,
): RequestHandler {
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > prepaidMaximumSourceBytes
  )
    throw Error("Invalid Prepaid upload byte limit.");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maximumBytes, files: 1, fields: 4, parts: 5 },
  }).single("file");
  let active = 0;
  return (req, res, next) => {
    if (active >= 2)
      return next(
        new AppError(
          503,
          "PREPAID_UPLOAD_BUSY",
          "Two source uploads are already in progress on this server. Retry shortly.",
        ),
      );
    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      res.off("finish", release);
      res.off("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
    upload(req, res, (error) => {
      if (error) release();
      next(error);
    });
  };
}

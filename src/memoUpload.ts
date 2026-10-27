import { AppError } from "./errors.js";
import type { ProcessingPipelineFileRequirement } from "./processingPipelineCatalog.js";

export type MemoUploadSelection = {
  originalName: string;
  expectedFileName: string;
};
export type MemoUploadAssignment = MemoUploadSelection & {
  savedFileName: string;
};

export function memoFileIdentity(fileName: string) {
  if (/[\\/\0]/.test(fileName)) return null;
  const match = /^(.+)_([^_]+)\.xlsx$/i.exec(
    fileName.replace(/(?:\.xlsx){2,}$/i, ".xlsx"),
  );
  return match ? { base: match[1], suffix: match[2] } : null;
}

export function matchesMemoUploadFile(expected: string, original: string) {
  const mapped = memoFileIdentity(expected);
  const uploaded = memoFileIdentity(original);
  return Boolean(
    mapped &&
    uploaded &&
    uploaded.suffix.trim() &&
    mapped.base.toLowerCase() === uploaded.base.toLowerCase(),
  );
}

export function matchesMemoStoredFile(expected: string, stored: string) {
  const identity = memoFileIdentity(stored);
  return Boolean(
    identity &&
    /^\d{2,}$/.test(identity.suffix) &&
    Number(identity.suffix) > 0 &&
    matchesMemoUploadFile(expected, stored),
  );
}

function dateOrder(suffix: string) {
  if (!/^\d{8}$/.test(suffix)) return null;
  const month = Number(suffix.slice(0, 2));
  const day = Number(suffix.slice(2, 4));
  const year = Number(suffix.slice(4));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AppError(
      400,
      "MEMO_INVALID_DATE",
      `${suffix} must be a valid MMDDYYYY date.`,
    );
  }
  return date.getTime();
}

/** Build the entire batch before writing objects so selection order cannot affect numbering. */
export function planMemoUploads(
  selections: readonly MemoUploadSelection[],
  requirements: readonly ProcessingPipelineFileRequirement[],
  inboundNames: readonly string[] = [],
): MemoUploadAssignment[] {
  const seen = new Set<string>();
  const groups = new Map<
    string,
    { selection: MemoUploadSelection; suffix: string; date: number | null }[]
  >();
  for (const selection of selections) {
    const requirement = requirements.find(
      (item) =>
        item.fileName.toLowerCase() ===
        selection.expectedFileName.toLowerCase(),
    );
    if (
      !requirement ||
      !matchesMemoUploadFile(requirement.fileName, selection.originalName)
    ) {
      throw new AppError(
        400,
        "PIPELINE_FILENAME_MISMATCH",
        `${selection.originalName} is not required by the current Memo file mapping.`,
      );
    }
    const identity = memoFileIdentity(selection.originalName)!;
    const duplicateKey = `${identity.base}_${identity.suffix}`.toLowerCase();
    if (seen.has(duplicateKey)) {
      throw new AppError(
        400,
        "MEMO_DUPLICATE_FILE",
        "Duplicate files cannot be uploaded in the same batch.",
      );
    }
    seen.add(duplicateKey);
    const group = groups.get(requirement.fileName) ?? [];
    group.push({
      selection: { ...selection, expectedFileName: requirement.fileName },
      suffix: identity.suffix,
      date: dateOrder(identity.suffix),
    });
    groups.set(requirement.fileName, group);
  }
  return Array.from(groups).flatMap(([expected, group]) => {
    const highest = inboundNames.reduce((maximum, name) => {
      if (!matchesMemoStoredFile(expected, name)) return maximum;
      return Math.max(maximum, Number(memoFileIdentity(name)!.suffix));
    }, 0);
    group.sort((left, right) => {
      if (left.date !== null && right.date !== null)
        return left.date - right.date;
      if (left.date !== null) return -1;
      if (right.date !== null) return 1;
      return left.suffix.localeCompare(right.suffix, "en", { numeric: true });
    });
    return group.map(({ selection }, index) => ({
      ...selection,
      savedFileName: `${memoFileIdentity(expected)!.base}_${String(highest + index + 1).padStart(2, "0")}.XLSX`,
    }));
  });
}

import { AppError } from "../../../errors.js";

export function mapStorageError(error: unknown) {
  if (
    error instanceof Error &&
    error.message ===
      "Requested key is outside the selected processing pipeline folder."
  ) {
    return new AppError(
      404,
      "PIPELINE_FILE_NOT_FOUND",
      "The requested file is not available in the selected pipeline.",
    );
  }
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "NoSuchKey" || name === "NotFound") {
    return new AppError(
      404,
      "PIPELINE_FILE_NOT_FOUND",
      "The requested file was not found in storage.",
    );
  }
  if (name === "AccessDenied") {
    return new AppError(
      502,
      "PIPELINE_STORAGE_DENIED",
      "The pipeline storage service denied access to this file.",
    );
  }
  return error;
}

export function mapStepFunctionError(error: unknown) {
  if (error instanceof AppError) return error;
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (
    name === "StateMachineDoesNotExist" ||
    name === "StateMachineDoesNotExistException" ||
    name === "ExecutionDoesNotExist" ||
    name === "ExecutionDoesNotExistException"
  ) {
    return new AppError(
      404,
      "PIPELINE_STEP_FUNCTION_NOT_FOUND",
      "The mapped Step Functions execution target no longer exists.",
    );
  }
  if (name === "InvalidExecutionInput") {
    return new AppError(
      400,
      "PIPELINE_STEP_FUNCTION_INPUT_INVALID",
      "AWS Step Functions rejected the execution input.",
    );
  }
  if (name === "ExecutionLimitExceeded" || name === "ExecutionAlreadyExists") {
    return new AppError(
      409,
      "PIPELINE_STEP_FUNCTION_RUN_LIMIT",
      "This Step Functions execution cannot be started at this time.",
    );
  }
  if (name === "AccessDeniedException" || name === "UnauthorizedException") {
    return new AppError(
      502,
      "PIPELINE_STEP_FUNCTION_ACCESS_DENIED",
      "The portal is not permitted to run the mapped Step Functions state machine.",
    );
  }
  return new AppError(
    502,
    "PIPELINE_STEP_FUNCTION_UNAVAILABLE",
    "The Step Functions service could not process this request. Please try again.",
  );
}

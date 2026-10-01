export type AppUserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  okta_subject: string | null;
  display_name: string | null;
  is_admin: boolean;
  is_active: boolean;
  must_change_password: boolean;
  token_version: number;
  created_at: Date;
};
/** @deprecated Use AppUserRow. Retained while downstream tests migrate. */
export type UserRow = AppUserRow;
export type UploadRow = {
  id: string;
  workflow: "prepaid" | "memo" | "aprm";
  slot: string | null;
  original_name: string;
  object_key: string;
  size: number;
  content_type: string;
  created_at: Date;
};

export function userDto(user: AppUserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at.toISOString(),
  };
}

export function uploadDto(upload: UploadRow) {
  return {
    id: upload.id,
    workflow: upload.workflow,
    ...(upload.slot ? { slot: upload.slot } : {}),
    originalName: upload.original_name,
    objectKey: upload.object_key,
    size: upload.size,
    contentType: upload.content_type,
    uploadedAt: upload.created_at.toISOString(),
  };
}

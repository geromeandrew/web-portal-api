# Feature modules

Each folder represents a business capability instead of a technical layer:

- `auth` — sign-in, sign-out, current user, password changes, and bootstrap admin setup.
- `users` — administrator user management.
- `uploads` — portal file upload metadata and Lambda upload integration.
- `prepaid` and `memo` — workflow state and exports.
- `processing-pipelines` — configured pipeline files, S3 storage, and AWS Glue jobs.

Add code to the closest feature first. Only put code in `modules/shared` when two or
more features genuinely need it.

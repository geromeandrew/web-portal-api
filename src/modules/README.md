# Feature modules

Each folder represents a business capability instead of a technical layer:

- `auth` — sign-in, sign-out, current user, password changes, and bootstrap admin setup.
- `users` — administrator user management.
- `uploads` — portal file upload metadata and Lambda upload integration.
- `prepaid` and `memo` — workflow state and exports.
- `processing-pipelines` — configured pipeline files, S3 storage, and Bayan Step Functions executions.

Add code to the closest feature first. Only put code in `modules/shared` when two or
more features genuinely need it.

Within a feature, keep the responsibilities predictable:

- `api/router.ts` registers Express routes and middleware.
- `api/controller.ts` parses HTTP input and shapes HTTP responses.
- `application/*Service.ts` owns the feature workflow and coordinates storage.

Keep SQL, AWS clients, authentication middleware, and other shared integrations out
of controllers whenever possible.

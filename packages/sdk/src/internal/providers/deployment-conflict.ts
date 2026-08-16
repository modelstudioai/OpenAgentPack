import { ConflictError } from "./base-client.ts";

export type PreparedDeploymentFiles = ReadonlyMap<string, string>;

/** Carries files uploaded before a deployment create conflict into the adoption update. */
export class DeploymentCreateConflictError extends ConflictError {
	constructor(
		conflict: ConflictError,
		public readonly preparedFiles: PreparedDeploymentFiles,
	) {
		super(conflict.statusCode, conflict.responseBody, "Deployment create");
		this.name = conflict.name;
		this.message = conflict.message;
		this.stack = conflict.stack;
	}
}

export function preserveDeploymentFilesOnConflict(error: unknown, preparedFiles: PreparedDeploymentFiles): never {
	if (error instanceof ConflictError && preparedFiles.size > 0) {
		throw new DeploymentCreateConflictError(error, preparedFiles);
	}
	throw error;
}

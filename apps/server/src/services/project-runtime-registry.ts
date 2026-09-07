import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BackendRuntimeInput } from "@openagentpack/sdk";
import { projectRuntimeManager } from "@/services/project-manager";

export interface AttachmentRecord {
	id: string;
	agent_id: string;
	provider: string;
	remote_file_id: string;
	filename: string;
	mime_type?: string;
	status?: string;
	available: boolean;
	created_at: string;
}

export interface SessionRecord {
	session_id: string;
	agent_id: string;
	provider: string;
	project_revision: string;
	created_at: string;
	/** Process-local pinned runtime. Deliberately omitted from the persisted JSON. */
	runtime?: BackendRuntimeInput;
}

interface RuntimeRegistryFile {
	version: 1;
	attachments: AttachmentRecord[];
	sessions: Array<Omit<SessionRecord, "runtime">>;
}

class ProjectRuntimeRegistry {
	private readonly filePath = join(
		process.env.AGENTS_RUNTIME_HOME?.trim() || join(homedir(), ".agents", "playground-runtime"),
		`${projectRuntimeManager.projectId}.json`,
	);
	private loadPromise?: Promise<RuntimeRegistryFile>;
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly pinnedRuntimes = new Map<string, BackendRuntimeInput>();

	async listAttachments(agentId?: string): Promise<AttachmentRecord[]> {
		const file = await this.load();
		return file.attachments.filter((attachment) => !agentId || attachment.agent_id === agentId);
	}

	async getAttachment(id: string): Promise<AttachmentRecord | undefined> {
		return (await this.load()).attachments.find((attachment) => attachment.id === id);
	}

	async putAttachment(record: AttachmentRecord): Promise<void> {
		const file = await this.load();
		file.attachments = [...file.attachments.filter((attachment) => attachment.id !== record.id), record];
		await this.persist(file);
	}

	async removeAttachment(id: string): Promise<void> {
		const file = await this.load();
		file.attachments = file.attachments.filter((attachment) => attachment.id !== id);
		await this.persist(file);
	}

	async putSession(record: SessionRecord): Promise<void> {
		const file = await this.load();
		file.sessions = [
			...file.sessions.filter((session) => session.session_id !== record.session_id),
			{
				session_id: record.session_id,
				agent_id: record.agent_id,
				provider: record.provider,
				project_revision: record.project_revision,
				created_at: record.created_at,
			},
		];
		if (record.runtime) this.pinnedRuntimes.set(record.session_id, record.runtime);
		await this.persist(file);
	}

	async getSession(id: string): Promise<SessionRecord | undefined> {
		const record = (await this.load()).sessions.find((session) => session.session_id === id);
		return record ? { ...record, runtime: this.pinnedRuntimes.get(id) } : undefined;
	}

	private async load(): Promise<RuntimeRegistryFile> {
		this.loadPromise ??= this.readFromDisk();
		return this.loadPromise;
	}

	private async readFromDisk(): Promise<RuntimeRegistryFile> {
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<RuntimeRegistryFile>;
			return {
				version: 1,
				attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
				sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { version: 1, attachments: [], sessions: [] };
			}
			throw error;
		}
	}

	private async persist(file: RuntimeRegistryFile): Promise<void> {
		this.writeQueue = this.writeQueue.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
			await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
			await rename(temporaryPath, this.filePath);
		});
		await this.writeQueue;
	}
}

export const projectRuntimeRegistry = new ProjectRuntimeRegistry();

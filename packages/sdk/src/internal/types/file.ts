export interface ProviderFileInfo {
	id: string;
	filename: string;
	mime_type: string;
	size_bytes: number;
	created_at: string;
	downloadable?: boolean;
	status?: string;
	purpose?: string;
}

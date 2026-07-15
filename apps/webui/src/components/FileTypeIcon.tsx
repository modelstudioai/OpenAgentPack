import { FileImage, FileMusic, FilePlay, FileText } from "lucide-react";

interface FileTypeIconProps {
	mimeType?: string | null;
	filename?: string | null;
	size?: number;
}

/** 按 MIME / 扩展名渲染文件类型图标 */
export function FileTypeIcon({ mimeType, filename, size = 16 }: FileTypeIconProps) {
	const mime = (mimeType ?? "").toLowerCase();
	const name = (filename ?? "").toLowerCase();

	if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|ico|heic|avif)$/.test(name)) {
		return <FileImage size={size} />;
	}
	if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|avi|mkv)$/.test(name)) {
		return <FilePlay size={size} />;
	}
	if (mime.startsWith("audio/") || /\.(mp3|wav|ogg|flac|aac|m4a)$/.test(name)) {
		return <FileMusic size={size} />;
	}
	return <FileText size={size} />;
}

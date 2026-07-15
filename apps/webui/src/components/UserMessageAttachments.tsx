import { FileText } from "lucide-react";

interface UserMessageAttachmentsProps {
	files: string[];
}

/** 用户消息气泡内的只读附件展示 */
export default function UserMessageAttachments({ files }: UserMessageAttachmentsProps) {
	if (files.length === 0) return null;

	return (
		<div className="run-msg-attachments">
			{files.map((name) => (
				<span key={name} className="run-msg-attachment" title={name}>
					<FileText size={14} aria-hidden />
					<span className="run-msg-attachment-name">{name}</span>
				</span>
			))}
		</div>
	);
}

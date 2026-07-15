import { type ReactNode, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useArtifactAccess } from "@/lib/artifact-access-context";
import { artifactDisplayName } from "@/lib/artifact-file-name";

const sanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
		img: [...(defaultSchema.attributes?.img ?? []), "src", "alt", "title", "loading"],
		code: [...(defaultSchema.attributes?.code ?? []), "className"],
	},
};

function childText(children: ReactNode): string | undefined {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) {
		const parts = children.map((c) => (typeof c === "string" ? c : "")).filter(Boolean);
		return parts.length > 0 ? parts.join("") : undefined;
	}
	return undefined;
}

function useArtifactMarkdownComponents(): Components {
	const access = useArtifactAccess();

	// 保持 components 引用稳定，避免 ReactMarkdown 在父级轮询重渲染时卸载/重建 <img> 导致闪烁。
	return useMemo(
		() => ({
			a: ({ href, children, ...props }) => {
				const url = href ?? "";
				const expired = Boolean(url && access?.isUrlExpired(url));
				const label = childText(children);
				return (
					<a
						href={expired ? undefined : href}
						target={expired ? undefined : "_blank"}
						rel={expired ? undefined : "noopener noreferrer"}
						className={expired ? "artifact-link-expired" : undefined}
						onClick={(event) => {
							if (expired && access) {
								event.preventDefault();
								access.promptRegenerate(url, artifactDisplayName(url, label));
							}
						}}
						{...props}
					>
						{children}
						{expired && <span className="artifact-expired-badge">已过期</span>}
					</a>
				);
			},
			img: ({ src, alt, ...props }) => {
				const url = src ?? "";
				if (url && access?.isUrlExpired(url)) {
					const name = artifactDisplayName(url, alt);
					return (
						<button type="button" className="artifact-media-expired" onClick={() => access.promptRegenerate(url, name)}>
							<span className="artifact-expired-badge">已过期</span>
							<span className="artifact-media-expired-label">{name}</span>
							<span className="artifact-media-expired-hint">点击重新生成下载链接</span>
						</button>
					);
				}
				return <img src={src} alt={alt ?? ""} loading="lazy" {...props} />;
			},
		}),
		[access],
	);
}

const defaultMarkdownComponents: Components = {
	a: ({ href, children, ...props }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
			{children}
		</a>
	),
	img: ({ src, alt, ...props }) => <img src={src} alt={alt ?? ""} loading="lazy" {...props} />,
};

interface MarkdownRendererProps {
	text: string;
	className?: string;
}

export function MarkdownRenderer({ text, className = "run-result-markdown" }: MarkdownRendererProps) {
	const trimmed = text.trim();
	const artifactComponents = useArtifactMarkdownComponents();
	const access = useArtifactAccess();
	const components = access ? artifactComponents : defaultMarkdownComponents;

	if (!trimmed) return null;

	return (
		<div className={className} data-spm-protocol="i">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
				components={components}
			>
				{trimmed}
			</ReactMarkdown>
		</div>
	);
}

import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UiModel } from "@/lib/domain/model-api";

function ModelIcon({ icon, name, size = 20 }: { icon: string; name: string; size?: number }) {
	if (!icon) {
		return <Sparkles size={size} />;
	}
	return <img src={icon} alt={name} width={size} height={size} style={{ borderRadius: 4, objectFit: "contain" }} />;
}

export default function ModelSelector({
	models,
	value,
	onChange,
}: {
	models: UiModel[];
	value: string;
	onChange: (modelId: string) => void;
}) {
	const selectedModel = models.find((m) => m.id === value) ?? models[0];
	const [open, setOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);

	// Close on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(target) &&
				!(target as Element).closest?.(".model-selector-dropdown")
			) {
				setOpen(false);
			}
		};
		document.addEventListener("click", handler);
		return () => document.removeEventListener("click", handler);
	}, []);

	if (!selectedModel) return null;

	return (
		<div className="model-selector-wrapper" ref={wrapperRef}>
			<button
				className="model-selector-trigger"
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open);
				}}
			>
				<span className="model-selector-icon" aria-hidden="true">
					<ModelIcon icon={selectedModel.icon} name={selectedModel.name} size={18} />
				</span>
				<span className="model-selector-name">{selectedModel.name}</span>
				<ChevronDown size={14} className={`model-selector-chevron ${open ? "open" : ""}`} />
			</button>

			{/* Backdrop for closing on outside click */}
			{open && (
				<button
					type="button"
					className="model-selector-backdrop"
					aria-label="关闭模型选择"
					onClick={(e) => {
						e.stopPropagation();
						setOpen(false);
					}}
				/>
			)}

			<div className={`model-selector-dropdown ${open ? "open" : ""}`}>
				<div className="model-selector-header">切换模型</div>
				<div className="model-selector-list">
					{models.map((model) => {
						const isSelected = model.id === selectedModel.id;
						return (
							<button
								key={model.id}
								className={`model-selector-item ${isSelected ? "selected" : ""}`}
								type="button"
								onClick={() => {
									onChange(model.id);
									setOpen(false);
								}}
							>
								<span className="model-item-icon">
									<ModelIcon icon={model.icon} name={model.name} />
								</span>
								<span className="model-item-info">
									<span className="model-item-name">{model.name}</span>
									{model.description && <span className="model-item-desc">{model.description}</span>}
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

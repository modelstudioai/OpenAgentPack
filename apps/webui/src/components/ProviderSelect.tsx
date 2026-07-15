import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { providerLogos } from "@/data/static-assets";
import type { AgentsConfigProvider } from "@/lib/domain/config-api";

function ProviderLogo({ provider }: { provider: AgentsConfigProvider }) {
	return (
		<span className={`settings-provider-logo settings-provider-logo--${provider}`} aria-hidden="true">
			<img src={providerLogos[provider]} alt="" />
		</span>
	);
}

type ProviderSelectProps = {
	id?: string;
	value: AgentsConfigProvider | "";
	options: readonly AgentsConfigProvider[];
	labels: Record<AgentsConfigProvider, string>;
	placeholder?: string;
	disabled?: boolean;
	onChange: (value: AgentsConfigProvider | "") => void;
};

type MenuPosition = {
	top?: number;
	bottom?: number;
	left: number;
	width: number;
};

const MENU_MAX_HEIGHT = 220;
const MENU_GAP = 6;
const MENU_Z_INDEX = 10001;

function estimateMenuHeight(optionCount: number): number {
	return Math.min(MENU_MAX_HEIGHT, optionCount * 44 + 12);
}

export default function ProviderSelect({
	id,
	value,
	options,
	labels,
	placeholder = "请选择 Provider",
	disabled = false,
	onChange,
}: ProviderSelectProps) {
	const listboxId = useId();
	const wrapperRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
	const [openUpward, setOpenUpward] = useState(false);

	const selectedLabel = value ? labels[value] : null;

	const close = useCallback(() => {
		setOpen(false);
		setActiveIndex(-1);
		setMenuPosition(null);
	}, []);

	const selectOption = useCallback(
		(option: AgentsConfigProvider) => {
			onChange(option);
			close();
		},
		[close, onChange],
	);

	const updateMenuPosition = useCallback(() => {
		const trigger = triggerRef.current;
		if (!trigger) return;

		const rect = trigger.getBoundingClientRect();
		const estimatedHeight = estimateMenuHeight(options.length);
		const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
		const spaceAbove = rect.top - MENU_GAP;
		const shouldOpenUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

		setOpenUpward(shouldOpenUp);
		setMenuPosition({
			left: rect.left,
			width: rect.width,
			top: shouldOpenUp ? undefined : rect.bottom + MENU_GAP,
			bottom: shouldOpenUp ? window.innerHeight - rect.top + MENU_GAP : undefined,
		});
	}, [options.length]);

	useLayoutEffect(() => {
		if (!open) return;
		updateMenuPosition();
		const handler = () => updateMenuPosition();
		window.addEventListener("resize", handler);
		window.addEventListener("scroll", handler, true);
		return () => {
			window.removeEventListener("resize", handler);
			window.removeEventListener("scroll", handler, true);
		};
	}, [open, updateMenuPosition]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (wrapperRef.current?.contains(target)) return;
			if (menuRef.current?.contains(target)) return;
			close();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [close, open]);

	useEffect(() => {
		if (!open) return;
		const index = value ? options.indexOf(value) : 0;
		setActiveIndex(index >= 0 ? index : 0);
	}, [open, options, value]);

	const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
		if (disabled) return;
		if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setOpen(true);
		}
		if (e.key === "Escape" && open) {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};

	const handleListKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => (i + 1) % options.length);
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => (i - 1 + options.length) % options.length);
		}
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			const option = options[activeIndex];
			if (option) selectOption(option);
		}
	};

	const portalTarget = triggerRef.current?.closest("dialog") ?? document.body;

	const menu =
		open && menuPosition
			? createPortal(
					<div
						ref={menuRef}
						id={listboxId}
						className={`settings-select-menu settings-select-menu--portal${openUpward ? " open-up" : ""}`}
						role="listbox"
						tabIndex={-1}
						style={{
							position: "fixed",
							left: menuPosition.left,
							width: menuPosition.width,
							top: menuPosition.top,
							bottom: menuPosition.bottom,
							zIndex: MENU_Z_INDEX,
						}}
						onKeyDown={handleListKeyDown}
					>
						{options.map((option, index) => {
							const isSelected = option === value;
							const isActive = index === activeIndex;
							return (
								<div key={option} role="presentation">
									<button
										type="button"
										role="option"
										className={`settings-select-option${isSelected ? " selected" : ""}${isActive ? " active" : ""}`}
										aria-selected={isSelected}
										onMouseEnter={() => setActiveIndex(index)}
										onClick={() => selectOption(option)}
									>
										<ProviderLogo provider={option} />
										<span className="settings-select-option-label">{labels[option]}</span>
										{isSelected ? <Check size={16} className="settings-select-check" aria-hidden="true" /> : null}
									</button>
								</div>
							);
						})}
					</div>,
					portalTarget,
				)
			: null;

	return (
		<div className={`settings-select${open ? " open" : ""}`} ref={wrapperRef}>
			<button
				ref={triggerRef}
				id={id}
				type="button"
				className="settings-select-trigger"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				onClick={() => {
					if (disabled) return;
					setOpen((prev) => !prev);
				}}
				onKeyDown={handleTriggerKeyDown}
			>
				<span className={`settings-select-value${selectedLabel ? "" : " is-placeholder"}`}>
					{value && selectedLabel ? (
						<span className="settings-select-value-content">
							<ProviderLogo provider={value} />
							<span className="settings-select-value-label">{selectedLabel}</span>
						</span>
					) : (
						placeholder
					)}
				</span>
				<ChevronDown size={16} className="settings-select-chevron" aria-hidden="true" />
			</button>
			{menu}
		</div>
	);
}

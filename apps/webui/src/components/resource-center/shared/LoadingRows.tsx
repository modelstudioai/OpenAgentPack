export function LoadingRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
	return Array.from({ length: rows }, (_, idx) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: these stateless skeleton rows never reorder or preserve identity
		<tr key={`loading-${idx}`} className="rc-loading-row">
			<td colSpan={cols} aria-label="加载中">
				<span className="rc-skeleton" />
			</td>
		</tr>
	));
}

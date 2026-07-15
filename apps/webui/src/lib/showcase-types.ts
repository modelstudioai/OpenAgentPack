export type ShowcaseMediaType = "image" | "video";

export interface ShowcaseMediaThumb {
	type: ShowcaseMediaType;
	url: string;
	poster?: string;
}

export interface ShowcaseMedia {
	type: ShowcaseMediaType;
	url: string;
	coverUrl?: string;
	poster?: string;
	thumbs?: ShowcaseMediaThumb[];
}

export interface ShowcaseCard {
	category: string;
	height: number;
	playbookName: string;
	prompt: string;
	playbookSlug?: string;
	imageId: number;
	media: ShowcaseMedia;
}

export function getShowcaseCoverUrl(media: ShowcaseMedia | undefined): string {
	if (!media) return "";
	return media.coverUrl ?? media.poster ?? media.url;
}

export function getShowcasePreviewItems(media: ShowcaseMedia | undefined): ShowcaseMediaThumb[] {
	if (!media) return [];
	if (media.thumbs && media.thumbs.length > 0) return media.thumbs;
	return [{ type: media.type, url: media.url, poster: media.poster }];
}

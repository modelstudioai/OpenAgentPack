export const staticAssets = {
	qwen: `https://img.alicdn.com/imgextra/i1/O1CN01w6jV4Z1j215jFjWxO_!!6000000004489-55-tps-28-28.svg`,
	glm: `https://img.alicdn.com/imgextra/i4/O1CN01ZxyM0h1yFxNoBD1CS_!!6000000006550-2-tps-84-84.png`,
	deepseek: `https://img.alicdn.com/imgextra/i2/O1CN01zYgaES268dz95iHkv_!!6000000007617-55-tps-272-200.svg`,
	provider: {
		bailian: `https://img.alicdn.com/imgextra/i3/O1CN01CIkpwb1MvDfO9ZFZc_!!6000000001496-49-tps-1280-1280.webp`,
		qoder: `https://img.alicdn.com/imgextra/i4/O1CN01PymEGh1r2wp4v4FIB_!!6000000005574-49-tps-1280-1280.webp`,
		ark: `https://img.alicdn.com/imgextra/i2/O1CN01j4pDr31lkYqNDbw8y_!!6000000004857-49-tps-1280-1280.webp`,
		claude: `https://img.alicdn.com/imgextra/i3/O1CN01wajaWl1h9E5vk5CjD_!!6000000004234-49-tps-1280-1280.webp`,
	},
} as const;

export const providerLogos = staticAssets.provider;

export const modelIcons: Partial<Record<string, string>> = {
	"qwen3.7-plus": staticAssets.qwen,
	"qwen3.7-max": staticAssets.qwen,
	"qwen3.6-plus": staticAssets.qwen,
	"qwen3.6-flash": staticAssets.qwen,
	"glm-5.1": staticAssets.glm,
	"deepseek-v4-pro": staticAssets.deepseek,
	"deepseek-v4-flash": staticAssets.deepseek,
};

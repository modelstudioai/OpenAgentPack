/// <reference types="vite/client" />

interface AliyunConsoleConfig {
	fEnv?: string;
}

interface Window {
	ALIYUN_CONSOLE_CONFIG?: AliyunConsoleConfig;
}

import { getKvJsonObjectCached, getKvUrlCached } from "../utils/kv.js";
import { jsonErrorResponse } from "../utils/response.js";

// KV 命名空间与键名
const RANDOM_IMG_CONFIG_NAMESPACE = "random-img-config";
const FOLDER_MAP_KEY = "FOLDER_MAP";
const BASE_IMAGE_URL_KEY = "BASE_IMAGE_URL";

// 允许的查询参数：d=设备, b=亮度, t=主题, m=响应方式
const ALLOWED_PARAMS = ["d", "b", "t", "m"];
// folderMap 中的设备类型：pc=桌面端, mb=移动端
const MAP_DEVICES = ["pc", "mb"];
// 请求可接受的设备值：在 MAP_DEVICES 基础上增加 r = 强制随机
const REQUEST_DEVICES = [...MAP_DEVICES, "r"];
// 可选亮度值
const BRIGHTNESS_VALUES = ["dark", "light"];
// 可选响应方式：proxy=代理转发, redirect=302 重定向
const METHOD_VALUES = ["proxy", "redirect"];

// 代理模式下上游请求的最大重试次数
const FETCH_MAX_ATTEMPTS = 3;
// 重试间隔基数（毫秒），实际延迟 = 基数 × 当前重试次数
const FETCH_RETRY_DELAY_MS = 50;
// 是否允许使用 redirect 方式（关闭则强制 proxy）
const REDIRECT_ENABLED = true;

// 图片文件名中序号的位数（如 000001.webp）
const IMAGE_FILENAME_DIGITS = 6;

// 将数组转为 Set，用于 O(1) 校验
const ALLOWED_PARAMS_SET = new Set(ALLOWED_PARAMS);
const REQUEST_DEVICE_SET = new Set(REQUEST_DEVICES);
const BRIGHTNESS_SET = new Set(BRIGHTNESS_VALUES);
const METHOD_SET = new Set(METHOD_VALUES);

// 统一错误定义：status 为 HTTP 状态码，message 为错误描述
const RANDOM_IMG_ERRORS = {
	INVALID_QUERY_PARAMS: { status: 400, message: "Bad Request: Invalid query parameters" },
	INVALID_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
	INVALID_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
	INVALID_THEME: { status: 400, message: "Bad Request: Invalid theme" },
	THEME_CONFLICT: { status: 400, message: "Bad Request: Cannot mix include and exclude theme selectors" },
	INVALID_METHOD: { status: 400, message: "Bad Request: Invalid method" },
	BASE_IMAGE_URL_CONFIG_ERROR: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
	FOLDER_MAP_CONFIG_ERROR: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
	NO_IMAGES_FOR_COMBINATION: { status: 404, message: "Not Found: No available images for the selected filters" },
	NO_AVAILABLE_IMAGES: { status: 404, message: "Not Found: No available images" },
	UPSTREAM_BAD_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
	UPSTREAM_FETCH_EXCEPTION: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};

let validThemeCache = {
	themes: null,
	themeSet: null,
	sourceRef: null,
};

// 构造字段校验失败的错误响应，包含字段名、实际值及可选的允许列表
const fieldErrorResponse = (error, field, received, allowed = undefined) => {
	const details = { field, received };
	if (allowed) {
		details.allowed = allowed;
	}
	return jsonErrorResponse(error, details);
};

// 校验请求的查询参数是否均在允许列表内
const validateAllowedQueryParams = (params) => {
	for (const key of params.keys()) {
		if (!ALLOWED_PARAMS_SET.has(key)) {
			return jsonErrorResponse(RANDOM_IMG_ERRORS.INVALID_QUERY_PARAMS, {
				invalidParams: [key],
				allowedParams: ALLOWED_PARAMS,
			});
		}
	}
	return null;
};

// 从 folderMap 中提取所有有效主题名列表
const buildValidThemes = (folderMap) =>
	Array.from(
		new Set(
			MAP_DEVICES.flatMap((device) =>
				Object.values(folderMap[device] ?? {}).flatMap((brightnessMap) =>
					Object.keys(brightnessMap ?? {})
				)
			)
		)
	);

// 确保 validThemeCache 与当前 folderMap 同步，必要时重建
const ensureValidThemeCache = (folderMap) => {
	if (validThemeCache.themes && validThemeCache.sourceRef === folderMap) {
		return validThemeCache;
	}

	const themes = buildValidThemes(folderMap);
	validThemeCache = {
		themes,
		themeSet: new Set(themes),
		sourceRef: folderMap,
	};

	return validThemeCache;
};

// 根据 baseImageUrl 和所选文件夹信息构造随机图片 URL
const buildImageUrl = (baseImageUrl, selectedFolder) => {
	const imageNumber = Math.floor(Math.random() * selectedFolder.count) + 1;
	const imageFilename = `${String(imageNumber).padStart(IMAGE_FILENAME_DIGITS, "0")}.webp`;
	return `${baseImageUrl}${selectedFolder.device}-${selectedFolder.brightness}/${selectedFolder.theme}/${imageFilename}`;
};

// 按照指定方式（proxy/redirect）响应图片请求
const respondImageByMethod = async (method, imageUrl) => {
	if (method === "redirect") {
		return new Response(null, {
			status: 302,
			headers: { Location: imageUrl },
		});
	}

	for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
		try {
			const upstreamResponse = await fetch(imageUrl);

			if (!upstreamResponse.ok) {
				return jsonErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_BAD_STATUS, {
					upstreamStatus: upstreamResponse.status,
					upstreamStatusText: upstreamResponse.statusText || undefined,
					hint: "Upstream responded but did not return a success status",
				});
			}

			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			});
		} catch {
			if (attempt >= FETCH_MAX_ATTEMPTS) {
				return jsonErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_FETCH_EXCEPTION, {
					hint: "Upstream request failed before receiving a valid response",
					retryAttempts: attempt,
				});
			}
			await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
		}
	}
};

// 处理 /random-img 路由的核心逻辑
const handleRandomImg = async (request, env) => {
	let params;
	try {
		params = new URL(request.url).searchParams;
	} catch {
		return jsonErrorResponse({
			status: 400,
			message: "Bad Request: Request URL is malformed or cannot be parsed",
		}, {
			hint: "Ensure the request URL is valid and properly encoded",
		});
	}

	const invalidParamsResponse = validateAllowedQueryParams(params);
	if (invalidParamsResponse) {
		return invalidParamsResponse;
	}

	const method = params.get("m")?.toLowerCase() || "proxy";
	if (!METHOD_SET.has(method)) {
		return fieldErrorResponse(RANDOM_IMG_ERRORS.INVALID_METHOD, "m", method, METHOD_VALUES);
	}
	const effectiveMethod = REDIRECT_ENABLED ? method : "proxy";

	const requestedDevice = params.get("d")?.toLowerCase() || null;
	if (requestedDevice && !REQUEST_DEVICE_SET.has(requestedDevice)) {
		return fieldErrorResponse(RANDOM_IMG_ERRORS.INVALID_DEVICE, "d", requestedDevice, REQUEST_DEVICES);
	}

	let autoDevice = "r";
	if (!requestedDevice) {
		const userAgent = request.headers.get("User-Agent") || "";
		const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
		const isDesktop = /Windows|Macintosh|Linux x86_64|X11/i.test(userAgent);
		autoDevice = isMobile ? "mb" : (isDesktop ? "pc" : "r");
	}
	const device = requestedDevice || autoDevice;
	const deviceCandidates = device === "r" ? MAP_DEVICES : [device];

	const requestedBrightness = params.get("b")?.toLowerCase() || null;
	if (requestedBrightness && !BRIGHTNESS_SET.has(requestedBrightness)) {
		return fieldErrorResponse(RANDOM_IMG_ERRORS.INVALID_BRIGHTNESS, "b", requestedBrightness, BRIGHTNESS_VALUES);
	}
	const brightnessCandidates = requestedBrightness ? [requestedBrightness] : BRIGHTNESS_VALUES;

	const rawThemeParams = Array.from(new Set(params
		.getAll("t")
		.flatMap((value) => value.split(","))
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)));

	const includeThemes = rawThemeParams.filter((v) => !v.startsWith("!"));
	const excludeThemes = rawThemeParams.filter((v) => v.startsWith("!")).map((v) => v.slice(1)).filter(Boolean);

	if (includeThemes.length > 0 && excludeThemes.length > 0) {
		return jsonErrorResponse(RANDOM_IMG_ERRORS.THEME_CONFLICT, {
			include: includeThemes,
			exclude: excludeThemes,
		});
	}

	const [folderMap, baseImageUrl] = await Promise.all([
		getKvJsonObjectCached({
			env,
			namespace: RANDOM_IMG_CONFIG_NAMESPACE,
			key: FOLDER_MAP_KEY,
			cacheKey: "random-img::folder-map",
		}),
		getKvUrlCached({
			env,
			namespace: RANDOM_IMG_CONFIG_NAMESPACE,
			key: BASE_IMAGE_URL_KEY,
			cacheKey: "random-img::base-image-url",
		}),
	]);
	if (!folderMap) {
		return jsonErrorResponse(RANDOM_IMG_ERRORS.FOLDER_MAP_CONFIG_ERROR);
	}
	if (!baseImageUrl) {
		return jsonErrorResponse(RANDOM_IMG_ERRORS.BASE_IMAGE_URL_CONFIG_ERROR);
	}

	const themeCache = ensureValidThemeCache(folderMap);
	const allMentionedThemes = [...includeThemes, ...excludeThemes];

	if (allMentionedThemes.length > 0) {
		const invalidTheme = allMentionedThemes.find((t) => !themeCache.themeSet.has(t));
		if (invalidTheme) {
			const received = excludeThemes.includes(invalidTheme) ? `!${invalidTheme}` : invalidTheme;
			return fieldErrorResponse(RANDOM_IMG_ERRORS.INVALID_THEME, "t", received);
		}
	}

	let themeCandidates;
	if (includeThemes.length > 0) {
		themeCandidates = includeThemes;
	} else if (excludeThemes.length > 0) {
		const excludeSet = new Set(excludeThemes);
		themeCandidates = themeCache.themes.filter((t) => !excludeSet.has(t));
	} else {
		themeCandidates = themeCache.themes;
	}

	const candidates = [];
	for (const candidateDevice of deviceCandidates) {
		const deviceMap = folderMap[candidateDevice] ?? {};
		for (const brightness of brightnessCandidates) {
			for (const theme of themeCandidates) {
				const count = Number(deviceMap?.[brightness]?.[theme] ?? 0);
				if (Number.isFinite(count) && count > 0) {
					candidates.push({ device: candidateDevice, brightness, theme, count });
				}
			}
		}
	}

	if (candidates.length === 0) {
		if (requestedBrightness || includeThemes.length > 0 || excludeThemes.length > 0) {
			const filters = {
				device,
				brightness: requestedBrightness,
			};
			if (includeThemes.length > 0) {
				filters.themes = includeThemes;
			}
			if (excludeThemes.length > 0) {
				filters.excludedThemes = excludeThemes;
			}
			return jsonErrorResponse(RANDOM_IMG_ERRORS.NO_IMAGES_FOR_COMBINATION, { filters });
		}
		return jsonErrorResponse(RANDOM_IMG_ERRORS.NO_AVAILABLE_IMAGES, {
			hint: "Check FOLDER_MAP counts in KV to ensure at least one image count is greater than 0",
		});
	}

	let selectedFolder;
	if (candidates.length === 1) {
		selectedFolder = candidates[0];
	} else {
		const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
		if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
			return jsonErrorResponse(RANDOM_IMG_ERRORS.NO_AVAILABLE_IMAGES, {
				hint: "No valid weighted candidates available",
			});
		}

		let remainingWeight = Math.random() * totalWeight;
		selectedFolder = null;
		for (const candidate of candidates) {
			remainingWeight -= candidate.count;
			if (remainingWeight < 0) {
				selectedFolder = candidate;
				break;
			}
		}
		if (!selectedFolder) {
			selectedFolder = candidates[candidates.length - 1];
		}
	}

	return await respondImageByMethod(effectiveMethod, buildImageUrl(baseImageUrl, selectedFolder));
};

export default {
	async fetch(request, env) {
		try {
			if (request.method !== "GET") {
				return jsonErrorResponse({ status: 405, message: "Method Not Allowed" });
			}

			const url = new URL(request.url);
			if (url.pathname === "/random-img") {
				return await handleRandomImg(request, env);
			}

			return jsonErrorResponse({ status: 404, message: "API Not Found" });
		} catch (error) {
			console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
			return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
		}
	},
};
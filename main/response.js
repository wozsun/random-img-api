// ===========================
// 响应工具函数
// ===========================

// 返回带可选 details 的 JSON 错误响应
export const detailedErrorResponse = (error, details = undefined) => {
	const payload = {
		status: error.status,
		message: error.message,
	};

	if (details && Object.keys(details).length > 0) {
		payload.details = details;
	}

	return new Response(JSON.stringify(payload), {
		status: error.status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
};

// 返回基础 JSON 错误响应
export const jsonErrorResponse = (error) => detailedErrorResponse(error);

// 返回 JSON 成功响应
export const jsonSuccessResponse = (data, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});

import { AppError } from "../../middleware/error";
import type { AppContext } from "../../types";
import { isAdminRequest } from "../team/team.service";
import {
	normalizeBillingModelKey,
	type BillingModelKind,
} from "./billing.models";
import {
	deleteModelCreditCost,
	getModelCreditCost,
	listModelCreditCosts,
	listModelCreditCostSpecs,
	upsertModelCreditCost,
} from "./billing.repo";
import { listCatalogModels } from "../model-catalog/model-catalog.repo";

function requireAdmin(c: AppContext): void {
	if (!isAdminRequest(c)) {
		throw new AppError("Forbidden", { status: 403, code: "forbidden" });
	}
}

function fallbackCostForTaskKind(kind: string | null | undefined): number {
	const k = (kind || "").trim();
	if (k === "text_to_image" || k === "image_edit") return 1;
	if (k === "text_to_video" || k === "image_to_video") return 10;
	return 0;
}

type SpecCondition = {
	field: string;
	value: string;
};

// 解析规格条件：resolution:2K&&quality:medium -> [{field:"resolution",value:"2k"},{field:"quality",value:"medium"}]
function parseSpecConditions(specKey: string): SpecCondition[] {
	return specKey
		.split("&&")
		.map((segment) => segment.trim())
		.filter(Boolean)
		.map((segment) => {
			const separatorIndex = segment.indexOf(":");
			if (separatorIndex <= 0) return null;
			const field = segment.slice(0, separatorIndex).trim().toLowerCase();
			const value = segment.slice(separatorIndex + 1).trim().toLowerCase();
			if (!field || !value) return null;
			return { field, value };
		})
		.filter((item): item is SpecCondition => item !== null);
}

// 判断某条规格的全部条件是否都命中字段值
function matchSpecConditions(
	conditions: SpecCondition[],
	specValues: Record<string, string>,
): boolean {
	if (conditions.length === 0) return false;
	return conditions.every((condition) => {
		const raw = specValues[condition.field];
		return typeof raw === "string" && raw.trim().toLowerCase() === condition.value;
	});
}

// 从多条规格里选出命中者：条件数最多（最具体）优先
function pickMatchedSpec(
	specRows: Array<{ spec_key: string; cost: number; enabled: number }>,
	specValues: Record<string, string>,
): number | null {
	let best: { cost: number; conditionCount: number } | null = null;
	for (const row of specRows) {
		if (Number(row.enabled ?? 1) === 0) continue;
		const conditions = parseSpecConditions(String(row.spec_key || ""));
		if (conditions.length === 0) continue;
		if (!matchSpecConditions(conditions, specValues)) continue;
		const cost = Math.max(0, Math.floor(Number(row.cost ?? 0) || 0));
		if (!best || conditions.length > best.conditionCount) {
			best = { cost, conditionCount: conditions.length };
		}
	}
	return best ? best.cost : null;
}

function imageResolutionSpecKey(specKey: string): string | null {
	const parts = specKey.trim().toLowerCase().split(":").filter(Boolean);
	if (parts[0] !== "image") return null;
	const resolution = parts.find((part) => /^(?:1k|2k|4k)$/.test(part));
	return resolution ? `image:${resolution}` : null;
}

export function resolveSyntheticImageSpecCostFromBase(input: {
	baseCost: number | null | undefined;
	specKey: string | null | undefined;
}): number | null {
	const normalizedSpecKey =
		typeof input.specKey === "string" ? input.specKey.trim().toLowerCase() : "";
	if (!normalizedSpecKey) return null;
	const resolutionSpec = imageResolutionSpecKey(normalizedSpecKey);
	if (!resolutionSpec || resolutionSpec !== normalizedSpecKey) return null;
	const baseCost =
		typeof input.baseCost === "number" && Number.isFinite(input.baseCost)
			? Math.max(0, Math.floor(input.baseCost))
			: 0;
	if (baseCost <= 0) return null;
	return resolutionSpec === "image:4k" ? baseCost * 2 : baseCost;
}

export async function resolveTeamCreditsCostForTask(c: AppContext, input: {
	taskKind: string | null | undefined;
	modelKey?: string | null | undefined;
	specKey?: string | null | undefined;
	specValues?: Record<string, string> | null | undefined;
}): Promise<number> {
	const normalizedModelKey = normalizeBillingModelKey(input.modelKey);
	if (!normalizedModelKey) {
		return fallbackCostForTaskKind(input.taskKind);
	}

	// 1. 字段条件匹配：specKey 形如 resolution:2K&&quality:medium，按实际字段值命中（纯 DB 计价）
	const specValues = input.specValues;
	if (specValues && Object.keys(specValues).length > 0) {
		const specRows = await listModelCreditCostSpecs(c.env.DB, normalizedModelKey);
		const matchedCost = pickMatchedSpec(specRows, specValues);
		if (matchedCost !== null) {
			return matchedCost;
		}
	}

	// 2. 精确 specKey 匹配：兼容 gpt-image-2-official 等旧格式（image:16_9:2k:high）
	const explicitSpec = typeof input.specKey === "string" ? input.specKey.trim() : "";
	if (explicitSpec) {
		const specRow = await getModelCreditCost(c.env.DB, normalizedModelKey, explicitSpec);
		if (specRow && Number(specRow.enabled ?? 1) !== 0) {
			return Math.max(0, Math.floor(Number(specRow.cost ?? 0) || 0));
		}
	}

	// 3. 基础价
	const baseRow = await getModelCreditCost(c.env.DB, normalizedModelKey);
	if (baseRow && Number(baseRow.enabled ?? 1) !== 0) {
		return Math.max(0, Math.floor(Number(baseRow.cost ?? 0) || 0));
	}

	// 4. 兜底默认价
	const fallback = fallbackCostForTaskKind(input.taskKind);
	if (fallback > 0) {
		return fallback;
	}

	throw new AppError("模型积分价格未配置", {
		status: 503,
		code: "model_pricing_unavailable",
		details: {
			modelKey: normalizedModelKey,
			taskKind: input.taskKind ?? null,
			specKey: null,
		},
	});
}

export async function listBillingModelCatalog(c: AppContext) {
	requireAdmin(c);
	const merged = new Map<
		string,
		{ modelKey: string; labelZh: string; kind: BillingModelKind; vendor?: string }
	>();

	const stripLabelOrientation = (label: string): string => {
		const raw = String(label || "").trim();
		if (!raw) return raw;
		// Remove explicit orientation markers in labels.
		return raw
			.replace(/（\s*横屏\s*）/g, "")
			.replace(/（\s*竖屏\s*）/g, "")
			.replace(/\(\s*横屏\s*\)/g, "")
			.replace(/\(\s*竖屏\s*\)/g, "")
			// Within bracketed label parts like "（横屏 10s）" -> "（10s）"
			.replace(/（\s*(横屏|竖屏)\s+/g, "（")
			.replace(/\(\s*(横屏|竖屏)\s+/g, "(")
			.replace(/\s{2,}/g, " ")
			.trim();
	};

	// Dynamic model list from system model catalog.
	// IMPORTANT: include all configured modelKey regardless of enabled status.
	const dynamic = await listCatalogModels(c.env.DB);
	for (const row of dynamic) {
		if (!row) continue;
		const canonicalKey = normalizeBillingModelKey(row.model_key);
		if (!canonicalKey) continue;
		const kindRaw = typeof row.kind === "string" ? row.kind.trim() : "";
		if (kindRaw !== "text" && kindRaw !== "image" && kindRaw !== "video") continue;
		const labelZh = stripLabelOrientation(
			String(row.label_zh || "").trim() || canonicalKey,
		);
		const vendor =
			typeof row.vendor_key === "string" && row.vendor_key.trim()
				? row.vendor_key.trim()
				: undefined;
		if (!merged.has(canonicalKey)) {
			merged.set(canonicalKey, {
				modelKey: canonicalKey,
				labelZh,
				kind: kindRaw as BillingModelKind,
				...(vendor ? { vendor } : {}),
			});
		}
	}

	// Preserve keys that already exist in billing cost table even if they are
	// not present in current model catalog rows.
	const existingCosts = await listModelCreditCosts(c.env.DB);
	for (const row of existingCosts) {
		const canonicalKey = normalizeBillingModelKey(row.model_key);
		if (!canonicalKey || merged.has(canonicalKey)) continue;
		merged.set(canonicalKey, {
			modelKey: canonicalKey,
			labelZh: canonicalKey,
			kind: "text",
		});
	}

	return Array.from(merged.values()).map(({ modelKey, labelZh, kind, vendor }) => ({
		modelKey,
		labelZh,
		kind,
		...(vendor ? { vendor } : {}),
	}));
}

export async function listModelCreditCostsForAdmin(c: AppContext) {
	requireAdmin(c);
	return listModelCreditCosts(c.env.DB);
}

export async function upsertModelCreditCostForAdmin(
	c: AppContext,
	input: { modelKey: string; specKey?: string; cost: number; enabled?: boolean },
) {
	requireAdmin(c);
	const nowIso = new Date().toISOString();
	return upsertModelCreditCost(c.env.DB, {
		modelKey: input.modelKey,
		specKey: input.specKey,
		cost: input.cost,
		enabled: typeof input.enabled === "boolean" ? input.enabled : true,
		nowIso,
	});
}

export async function deleteModelCreditCostForAdmin(c: AppContext, modelKey: string, specKey?: string) {
	requireAdmin(c);
	await deleteModelCreditCost(c.env.DB, modelKey, specKey);
}

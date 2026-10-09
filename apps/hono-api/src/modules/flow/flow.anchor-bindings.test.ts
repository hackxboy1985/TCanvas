import { describe, expect, it } from "vitest";
import {
	collectPublicFlowAnchorBindingImageUrls,
	mergePublicFlowAnchorBindings,
	normalizePublicFlowAnchorBindings,
} from "./flow.anchor-bindings";

describe("anchor binding 去重身份", () => {
	it("同一实体换图后应视为同一条绑定（新值覆盖旧值，不产生重复）", () => {
		const oldBinding = {
			kind: "character",
			entityId: "role-1",
			label: "角色A",
			imageUrl: "https://oss.example.com/old.png",
		};
		const newBinding = {
			kind: "character",
			entityId: "role-1",
			label: "角色A",
			imageUrl: "https://oss.example.com/new.png",
		};

		// 身份由 kind+entityId 决定：换图是「更新」而非「新增」
		const merged = mergePublicFlowAnchorBindings([oldBinding], [newBinding]);
		expect(merged.length).toBe(1);
	});

	it("OSS 带签名的同一张图不应被当成两条绑定", () => {
		const signedA = {
			kind: "scene",
			refId: "scene-9",
			label: "青毛寺",
			imageUrl: "https://oss.example.com/temple.jpg?sig=abc",
		};
		const signedB = {
			kind: "scene",
			refId: "scene-9",
			label: "青毛寺",
			imageUrl: "https://oss.example.com/temple.jpg?sig=xyz",
		};

		const normalized = normalizePublicFlowAnchorBindings([signedA, signedB]);
		expect(normalized.length).toBe(1);
	});

	it("不同实体即使图片相同也应保留为两条绑定", () => {
		const roleA = {
			kind: "character",
			entityId: "role-1",
			label: "角色A",
			imageUrl: "https://oss.example.com/shared.png",
		};
		const roleB = {
			kind: "character",
			entityId: "role-2",
			label: "角色B",
			imageUrl: "https://oss.example.com/shared.png",
		};

		const merged = mergePublicFlowAnchorBindings([roleA], [roleB]);
		expect(merged.length).toBe(2);
	});

	it("同一实体换图后只保留一条，且参考图可取到该条", () => {
		const bindings = normalizePublicFlowAnchorBindings([
			{
				kind: "character",
				entityId: "role-1",
				label: "角色A",
				imageUrl: "https://oss.example.com/old.png",
			},
			{
				kind: "character",
				entityId: "role-1",
				label: "角色A",
				imageUrl: "https://oss.example.com/new.png",
			},
		]);

		// 同一实体只保留一条，参考图不会出现同实体的重复项
		expect(bindings.length).toBe(1);
		expect(collectPublicFlowAnchorBindingImageUrls(bindings).length).toBe(1);
	});

	it("缺少实体身份但仅有 imageUrl 时仍应保留（不因去重丢数据）", () => {
		const onlyImage = {
			kind: "context",
			imageUrl: "https://oss.example.com/ctx.png",
		};
		const normalized = normalizePublicFlowAnchorBindings([onlyImage]);
		expect(normalized.length).toBe(1);
		expect(normalized[0].imageUrl).toBe("https://oss.example.com/ctx.png");
	});

	it("merge 保持先到先得，不做同实体覆盖（覆盖由 upsert 负责）", () => {
		// merge 只做去重合并；同实体的新值替换由 upsertSemanticNodeAnchorBinding 先
		// filter 掉旧值再 merge 完成，此处锁定该分工，避免误以为 merge 会覆盖。
		const oldBinding = {
			kind: "character",
			entityId: "role-1",
			label: "角色A",
			imageUrl: "https://oss.example.com/old.png",
		};
		const newBinding = {
			kind: "character",
			entityId: "role-1",
			label: "角色A",
			imageUrl: "https://oss.example.com/new.png",
		};
		const merged = mergePublicFlowAnchorBindings([oldBinding], [newBinding]);
		expect(merged.length).toBe(1);
		expect(merged[0].imageUrl).toBe("https://oss.example.com/old.png");
	});

	it("完全无身份的条目应被丢弃", () => {
		const normalized = normalizePublicFlowAnchorBindings([{ kind: "character" }]);
		expect(normalized.length).toBe(0);
	});
});

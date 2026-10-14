import { describe, expect, test } from "bun:test";
import {
	CreateSessionRequestSchema,
	CreateSessionResponseSchema,
	SessionSchema,
} from "../../src/internal/types/dto.ts";

for (const { name, schema, requiredFields } of [
	{ name: "SessionSchema", schema: SessionSchema, requiredFields: { session_id: "sess_1" } },
	{ name: "CreateSessionRequestSchema", schema: CreateSessionRequestSchema, requiredFields: { agent_id: "agent_1" } },
	{
		name: "CreateSessionResponseSchema",
		schema: CreateSessionResponseSchema,
		requiredFields: { session_id: "sess_1" },
	},
]) {
	describe(`${name} environment variables`, () => {
		test.each([{ FEATURE_FLAG: "on", COMPLEX_VALUE: "alpha=beta;中文", EMPTY_VALUE: "" }, {}] satisfies Record<
			string,
			string
		>[])("preserves string maps %j", (environmentVariables) => {
			const parsed = schema.parse({ ...requiredFields, environment_variables: environmentVariables });
			expect(parsed.environment_variables).toEqual(environmentVariables);
		});

		test("accepts payloads without environment variables", () => {
			expect(schema.parse(requiredFields)).not.toHaveProperty("environment_variables");
		});

		test.each([
			{ environmentVariables: null },
			{ environmentVariables: "FEATURE_FLAG=on" },
			{ environmentVariables: ["on"] },
			{ environmentVariables: { FEATURE_FLAG: 1 } },
		])("rejects non-string maps %j", ({ environmentVariables }) => {
			expect(schema.safeParse({ ...requiredFields, environment_variables: environmentVariables }).success).toBe(false);
		});
	});
}

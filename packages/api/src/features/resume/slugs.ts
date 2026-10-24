import type { DbOrTx } from "@reactive-resume/db/client";
import { and, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { slugify } from "@reactive-resume/utils/string";

/** Lowercase letters and numbers, in groups joined by single dashes. Only new and changed slugs must match. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// After a rename the old address keeps working this long.
const REDIRECT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** `stem`, or `stem-2`, `stem-3`… whichever isn't taken. */
function pickFreeSlug(stem: string, taken: ReadonlySet<string>) {
	if (!taken.has(stem)) return stem;
	for (let suffix = 2; ; suffix++) {
		if (!taken.has(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
	}
}

/** Slugs cannot exceed 64 chars. */
export const MAX_SLUG_LENGTH = 64;

// Slugs cannot exceed 64 chars. Keep base stem short enough so numerical suffixes stay within 64.
export const MAX_STEM_LENGTH = 56;

/** A slug made from `name` that none of the user's resumes uses yet. */
export async function findFreeSlug(client: DbOrTx, userId: string, name: string) {
	const rawStem = slugify(name) || "resume";
	const stem = rawStem.slice(0, MAX_STEM_LENGTH).replace(/-+$/, "") || "resume";
	const rows = await client
		.select({ slug: schema.resume.slug })
		.from(schema.resume)
		.where(
			and(eq(schema.resume.userId, userId), or(eq(schema.resume.slug, stem), like(schema.resume.slug, `${stem}-%`))),
		);

	return pickFreeSlug(stem, new Set(rows.map((row) => row.slug)));
}

/** Whether a slug can be this resume's address, and if not, why and what would work instead. */
export async function checkSlug(input: { userId: string; resumeId: string; slug: string }) {
	if (input.slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(input.slug)) {
		const rawSuggestion = slugify(input.slug);
		const suggestion = rawSuggestion
			? rawSuggestion.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "") || undefined
			: undefined;
		return { status: "invalid" as const, ...(suggestion && suggestion !== input.slug ? { suggestion } : {}) };
	}

	const [holder] = await db
		.select({ id: schema.resume.id, name: schema.resume.name })
		.from(schema.resume)
		.where(and(eq(schema.resume.userId, input.userId), eq(schema.resume.slug, input.slug)));

	if (!holder) return { status: "available" as const };
	if (holder.id === input.resumeId) return { status: "current" as const };

	return {
		status: "taken" as const,
		takenBy: holder.name,
		suggestion: await findFreeSlug(db, input.userId, input.slug),
	};
}

/**
 * Keeps the old address working for 30 days after a rename, and frees the new one from any older redirect: a
 * real resume's address always wins over a redirect.
 */
export async function recordSlugChange(
	client: DbOrTx,
	input: { userId: string; resumeId: string; from: string; to: string },
) {
	await client
		.delete(schema.resumeSlugRedirect)
		.where(and(eq(schema.resumeSlugRedirect.userId, input.userId), eq(schema.resumeSlugRedirect.slug, input.to)));

	const expiresAt = new Date(Date.now() + REDIRECT_LIFETIME_MS);
	await client
		.insert(schema.resumeSlugRedirect)
		.values({ userId: input.userId, resumeId: input.resumeId, slug: input.from, expiresAt })
		.onConflictDoUpdate({
			target: [schema.resumeSlugRedirect.userId, schema.resumeSlugRedirect.slug],
			set: { resumeId: input.resumeId, expiresAt },
		});
}

/** Matches a resume by its slug, or by a previous slug whose redirect hasn't expired. */
export function matchesSlug(slug: string) {
	return or(
		eq(schema.resume.slug, slug),
		inArray(
			schema.resume.id,
			db
				.select({ id: schema.resumeSlugRedirect.resumeId })
				.from(schema.resumeSlugRedirect)
				.where(
					and(
						eq(schema.resumeSlugRedirect.slug, slug),
						eq(schema.resumeSlugRedirect.userId, schema.resume.userId),
						gt(schema.resumeSlugRedirect.expiresAt, sql`now()`),
					),
				),
		),
	);
}

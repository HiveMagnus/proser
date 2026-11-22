import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { databaseService } from '@/lib/database';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mergeConfig = (...configs: Array<Record<string, unknown> | undefined>) =>
  configs.reduce<Record<string, unknown>>((merged, config) => {
    for (const [key, value] of Object.entries(config ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }, {});

export const DEFAULT_EDITORIAL_PROFILES = Object.freeze([
  { name: 'Balanced', version: '1.0.0', config: { styleGoals: ['clarity', 'specificity', 'voice fidelity'], mustPreserve: ['canon', 'intent', 'POV', 'tense'], sentenceVariance: 'natural', dialogueAttribution: 'minimal_when_clear' } },
  { name: 'Voice Fidelity', version: '1.0.0', config: { styleGoals: ['voice fidelity'], mustPreserve: ['diction', 'character voice', 'narrator distance'], sentenceVariance: 'source_relative' } },
  { name: 'Minimalist', version: '1.0.0', config: { styleGoals: ['clarity', 'compression'], mustAvoid: ['ornamental repetition', 'explanatory restatement'], figurativeDensity: 'low' } },
  { name: 'Lyrical', version: '1.0.0', config: { styleGoals: ['imagery', 'rhythmic variety'], mustPreserve: ['meaning', 'voice'], figurativeDensity: 'medium' } },
  { name: 'Commercial Pacing', version: '1.0.0', config: { styleGoals: ['momentum', 'clarity', 'strong scene turns'], mustPreserve: ['quiet-scene intent'], interiority: 'bounded' } },
]);

export interface ResolvedEditorialProfile {
  id: string | null;
  version: string;
  hash: string;
  name: string;
  config: Record<string, unknown>;
  preferenceSummary: Record<string, unknown>;
}

class EditorialProfileService {
  private get db() { return databaseService.client; }

  async list(userId: number) {
    return this.db.editorialProfile.findMany({ where: { userId }, orderBy: [{ name: 'asc' }, { createdAt: 'desc' }] });
  }

  async owned(userId: number, id: string) {
    const profile = await this.db.editorialProfile.findFirst({ where: { id, userId } });
    if (!profile) throw new Error('Editorial profile not found');
    return profile;
  }

  async create(userId: number, input: { name: string; bookId?: number; config: Record<string, unknown>; active?: boolean; parentId?: string }) {
    if (input.bookId) {
      const owned = await this.db.book.count({ where: { id: input.bookId, userId, deletedAt: null } });
      if (owned !== 1) throw new Error(`Book ${input.bookId} not found`);
    }
    if (input.parentId) await this.owned(userId, input.parentId);
    const previous = await this.db.editorialProfile.findFirst({ where: { userId, name: input.name }, orderBy: { createdAt: 'desc' } });
    const major = Number.parseInt(previous?.version.split('.')[0] ?? '0', 10);
    const version = previous ? `${major + 1}.0.0` : '1.0.0';
    const configHash = hash(input.config);
    return this.db.$transaction(async (tx) => {
      if (input.active) await tx.editorialProfile.updateMany({ where: { userId, bookId: input.bookId ?? null, active: true }, data: { active: false } });
      return tx.editorialProfile.create({ data: {
        id: randomUUID(), userId, bookId: input.bookId, parentId: input.parentId ?? previous?.id,
        name: input.name, version, active: input.active ?? false,
        config: input.config as Prisma.InputJsonValue, configHash,
      } });
    });
  }

  async activate(userId: number, bookId: number, profileId: string) {
    const profile = await this.owned(userId, profileId);
    if (profile.bookId && profile.bookId !== bookId) throw new Error('EDITORIAL_PROFILE_INVALID');
    const owned = await this.db.book.count({ where: { id: bookId, userId, deletedAt: null } });
    if (owned !== 1) throw new Error(`Book ${bookId} not found`);
    await this.db.$transaction([
      this.db.editorialProfile.updateMany({ where: { userId, bookId: profile.bookId, active: true }, data: { active: false } }),
      this.db.editorialProfile.update({ where: { id: profileId }, data: { active: true } }),
    ]);
    return this.resolve(userId, bookId, profileId);
  }

  async resolve(userId: number, bookId: number, profileId?: string): Promise<ResolvedEditorialProfile> {
    const explicit = profileId ? await this.owned(userId, profileId) : null;
    if (explicit?.bookId && explicit.bookId !== bookId) throw new Error('EDITORIAL_PROFILE_INVALID');
    const [globalProfile, bookProfile] = explicit ? [null, null] : await Promise.all([
      this.db.editorialProfile.findFirst({ where: { userId, bookId: null, active: true }, orderBy: { createdAt: 'desc' } }),
      this.db.editorialProfile.findFirst({ where: { userId, bookId, active: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    const selected = explicit ?? bookProfile ?? globalProfile;
    const config = mergeConfig(
      DEFAULT_EDITORIAL_PROFILES[0].config,
      (explicit?.config ?? globalProfile?.config) as Record<string, unknown> | undefined,
      (explicit ? undefined : bookProfile?.config) as Record<string, unknown> | undefined,
    );
    const evidence = await this.db.editorialPreferenceEvidence.findMany({
      where: { userId, OR: [{ bookId }, { bookId: null }], deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { evidenceType: true, passKey: true, weight: true, rationaleTags: true, createdAt: true },
    });
    const counts = new Map<string, number>();
    for (const item of evidence) {
      const key = `${item.passKey ?? 'all'}:${item.evidenceType}`;
      const ageDays = Math.max(0, (Date.now() - item.createdAt.getTime()) / 86_400_000);
      const decayed = item.weight * 0.5 ** (ageDays / 180);
      counts.set(key, (counts.get(key) ?? 0) + decayed);
    }
    const consistent = [...counts.entries()].filter(([, weight]) => Math.abs(weight) >= 2);
    const signals = consistent.slice(0, 20).map(([key, weight]) => ({ key, weight: Math.round(weight * 1_000) / 1_000 }));
    const preferenceSummary = {
      version: 'editorial-preferences-v1',
      minimumEvidence: 2,
      decayHalfLifeDays: 180,
      signals,
      hash: hash(signals),
    };
    return {
      id: selected?.id ?? null,
      version: selected?.version ?? DEFAULT_EDITORIAL_PROFILES[0].version,
      hash: hash(config),
      name: bookProfile && globalProfile ? `${globalProfile.name} + ${bookProfile.name}` : selected?.name ?? DEFAULT_EDITORIAL_PROFILES[0].name,
      config,
      preferenceSummary,
    };
  }
}

export const editorialProfileService = new EditorialProfileService();

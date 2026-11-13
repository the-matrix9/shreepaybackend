import { env } from '../config/env';
import { prisma } from '../lib/prisma';

export const SETTING_KEYS = ['min_withdrawal', 'registrations_open'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export async function getSettings() {
  const rows = await prisma.platformSetting.findMany();
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return {
    min_withdrawal: Number(m.get('min_withdrawal') ?? env.MIN_WITHDRAWAL),
    registrations_open: (m.get('registrations_open') ?? 'true') === 'true',
  };
}

export async function setSetting(key: SettingKey, value: string) {
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function getMinWithdrawalPaise(): Promise<bigint> {
  const s = await getSettings();
  return BigInt(Math.max(1, Math.floor(s.min_withdrawal))) * 100n;
}

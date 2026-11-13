import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

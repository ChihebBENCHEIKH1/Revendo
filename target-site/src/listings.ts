/**
 * Vitrine's catalogue.
 *
 * Intentionally thin. This service exists to be scraped and to decide whether to
 * allow it — the marketplace domain is set dressing, and the interesting domain
 * modelling lives in the Kotlin control plane where listings have a lifecycle.
 */

import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';

export interface Listing {
  readonly id: string;
  readonly title: string;
  readonly brand: string;
  readonly size: string;
  readonly condition: string;
  readonly priceCents: number;
  readonly description: string;
  readonly emoji: string;
  readonly createdAt: number;
  /** Set when the listing arrived through a worker rather than the seed. */
  readonly publishedByWorker: boolean;
}

export const NewListing = z.object({
  title: z.string().min(3).max(120),
  brand: z.string().min(1).max(60),
  size: z.string().min(1).max(20),
  condition: z.string().min(1).max(40),
  // The form posts a decimal string; money is stored in cents so we never do
  // floating-point arithmetic on a price.
  price: z.coerce.number().positive().max(100_000),
  description: z.string().max(600).default(''),
});

const EMOJI = ['👟', '🧥', '👜', '⌚', '🕶️', '👗', '🎧', '📷', '🧤', '🎒'];

const SEED: readonly Omit<Listing, 'id' | 'createdAt' | 'publishedByWorker'>[] = [
  { title: 'Air Max 90 — Infrared', brand: 'Nike', size: '42', condition: 'Très bon état', priceCents: 8900, description: 'Portées quelques fois.', emoji: '👟' },
  { title: 'Veste en cuir vintage', brand: 'Schott', size: 'M', condition: 'Bon état', priceCents: 24000, description: 'Cuir souple, doublure intacte.', emoji: '🧥' },
  { title: 'Sac Speedy 30', brand: 'Louis Vuitton', size: 'Unique', condition: 'Satisfaisant', priceCents: 55000, description: 'Patine naturelle.', emoji: '👜' },
  { title: 'Seamaster Aqua Terra', brand: 'Omega', size: '38mm', condition: 'Très bon état', priceCents: 310000, description: 'Boîte et papiers.', emoji: '⌚' },
  { title: 'Wayfarer polarisées', brand: 'Ray-Ban', size: 'Unique', condition: 'Neuf avec étiquette', priceCents: 9500, description: 'Jamais portées.', emoji: '🕶️' },
  { title: 'Robe plissée midi', brand: 'Sézane', size: '38', condition: 'Très bon état', priceCents: 6500, description: 'Coupe impeccable.', emoji: '👗' },
  { title: 'WH-1000XM4', brand: 'Sony', size: 'Unique', condition: 'Bon état', priceCents: 14500, description: 'Mousses remplacées.', emoji: '🎧' },
  { title: 'AE-1 Program + 50mm', brand: 'Canon', size: 'Unique', condition: 'Bon état', priceCents: 18000, description: 'Révisé, joints neufs.', emoji: '📷' },
];

export class ListingRepository {
  constructor(private readonly redis: Redis) {}

  async seedIfEmpty(): Promise<void> {
    const count = await this.redis.llen('vitrine:listings');
    if (count > 0) return;
    const now = Date.now();
    const seeded = SEED.map((s, i) => ({
      ...s,
      id: `seed-${i + 1}`,
      // Stagger creation times so the catalogue does not look generated in one tick.
      createdAt: now - (SEED.length - i) * 3_600_000,
      publishedByWorker: false,
    }));
    await this.redis.rpush('vitrine:listings', ...seeded.map((l) => JSON.stringify(l)));
  }

  async all(): Promise<Listing[]> {
    const raw = await this.redis.lrange('vitrine:listings', 0, -1);
    return raw.map((r) => JSON.parse(r) as Listing).sort((a, b) => b.createdAt - a.createdAt);
  }

  async create(input: z.infer<typeof NewListing>): Promise<Listing> {
    const listing: Listing = {
      id: randomUUID().slice(0, 8),
      title: input.title,
      brand: input.brand,
      size: input.size,
      condition: input.condition,
      priceCents: Math.round(input.price * 100),
      description: input.description,
      emoji: EMOJI[Math.floor(Math.random() * EMOJI.length)] as string,
      createdAt: Date.now(),
      publishedByWorker: true,
    };
    await this.redis.rpush('vitrine:listings', JSON.stringify(listing));
    return listing;
  }

  /** Drop worker-published listings and restore the seed, so `make demo` is reproducible. */
  async reset(): Promise<void> {
    await this.redis.del('vitrine:listings');
    await this.seedIfEmpty();
  }
}

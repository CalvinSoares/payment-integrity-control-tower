export type MetricsSnapshot = Record<string, number>;

function metricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  public increment(name: string, value = 1): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Incremento de métrica inválido.");
    const key = metricName(name);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  public snapshot(): MetricsSnapshot {
    return Object.fromEntries(this.counters.entries());
  }

  public toPrometheus(): string {
    return [...this.counters.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name} ${value}`)
      .join("\n");
  }
}

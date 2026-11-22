import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('proser.generation.operations');
const staleLeaseCounter = meter.createCounter('generation.stale_running_leases.total', {
  description: 'Expired running generation leases recovered during worker admission',
});
const recoveryLatency = meter.createHistogram('generation.stale_running_lease.recovery_latency_ms', {
  description: 'Delay between generation lease expiration and admission-time recovery',
  unit: 'ms',
});
const pendingExpirationCounter = meter.createCounter('generation.pending_expirations.total', {
  description: 'Expired pending generation operations terminalized during worker admission',
});

const localCounts = {
  staleRunningLeases: 0,
  pendingExpirations: 0,
  staleRunningRecoveryLatencyMs: 0,
};

export function recordGenerationAdmissionRecovery(
  staleRunningLeases: number,
  recoveryLatencyMs: number,
  pendingExpirations: number,
): void {
  if (staleRunningLeases > 0) {
    localCounts.staleRunningLeases += staleRunningLeases;
    localCounts.staleRunningRecoveryLatencyMs += recoveryLatencyMs;
    staleLeaseCounter.add(staleRunningLeases);
    recoveryLatency.record(recoveryLatencyMs / staleRunningLeases);
  }
  if (pendingExpirations > 0) {
    localCounts.pendingExpirations += pendingExpirations;
    pendingExpirationCounter.add(pendingExpirations);
  }
}

export function getGenerationOperationMetrics(): Readonly<typeof localCounts> {
  return { ...localCounts };
}

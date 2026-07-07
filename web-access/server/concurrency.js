// Phase 1 stub. Single client => always grant. Phase 2 replaces this with
// per-pane claim arbitration + output broadcast (see ADR-003).
export class ConcurrencyCoordinator {
  claim(/* paneId, clientId */) {
    return true;
  }
  release(/* paneId, clientId */) {}
  canWrite(/* paneId, clientId */) {
    return true;
  }
  currentWriter(/* paneId */) {
    return null;
  }
}

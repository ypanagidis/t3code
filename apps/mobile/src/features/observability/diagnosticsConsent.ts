let sendingDiagnostics = false;

export const diagnosticsSendingEnabled = () => sendingDiagnostics;

export function setDiagnosticsSendingEnabled(enabled: boolean) {
  sendingDiagnostics = enabled;
}

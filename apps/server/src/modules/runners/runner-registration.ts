import {
  RunnerEventSchema,
  RunnerRegistrationSchema,
  type RunnerRegistration,
} from "@roamcli/protocol";

export function parseRunnerRegistration(payload: unknown): RunnerRegistration {
  const direct = RunnerRegistrationSchema.safeParse(payload);
  if (direct.success) {
    return direct.data;
  }

  const wrapped = RunnerEventSchema.safeParse(payload);
  if (wrapped.success && wrapped.data.type === "registered") {
    return wrapped.data.runner;
  }

  return RunnerRegistrationSchema.parse(payload);
}

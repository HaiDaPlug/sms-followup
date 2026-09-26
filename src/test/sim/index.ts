// Barrel for scenario suites. The vi.mock factories must still import
// "@/test/sim/fakeClinic" directly (see the snippet at the top of that file);
// importing this barrel from a test body is fine.
export * from "./clock";
export * from "./fakeClinic";

// The production plugin resolves this symbol from the Rust app runtime.
// Package-only XCTest has no app runtime, so provide the test-only symbol.
void gai_memory_pressure(unsigned char level) {
    (void)level;
}

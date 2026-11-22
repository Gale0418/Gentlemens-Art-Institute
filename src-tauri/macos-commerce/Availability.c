int gai_macos_storekit_available(void) {
    if (__builtin_available(macOS 12.0, *)) {
        return 1;
    }
    return 0;
}

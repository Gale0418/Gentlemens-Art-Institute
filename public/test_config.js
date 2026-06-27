const { invoke } = window.__TAURI__.core;
invoke('set_config', { data: { scanDir: '/tmp' } }).then(console.log).catch(console.error);

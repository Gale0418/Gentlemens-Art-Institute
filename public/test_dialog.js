const { invoke } = window.__TAURI__.core;
invoke('plugin:dialog|open', { directory: true }).then(console.log).catch(console.error);

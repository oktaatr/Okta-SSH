import '@xterm/xterm/css/xterm.css';
import './styles.css';
import * as vm from './presentation/viewmodels/AppViewModel.js';
import { setupSessionListeners, render } from './presentation/views/AppView.js';
import { setUpdateCallback } from './presentation/models/AppState.js';

setUpdateCallback(render);
setupSessionListeners();
vm.loadConnections();

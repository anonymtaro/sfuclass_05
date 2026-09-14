import { registerRootComponent } from 'expo';
import App from './App';

// Expo's entry point. registerRootComponent calls AppRegistry.registerComponent
// and sets the right root tag in both the dev client and a release build, so
// there is nothing platform-specific to keep in sync here.
registerRootComponent(App);
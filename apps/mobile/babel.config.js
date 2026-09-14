module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Keeps imports identical to apps/web, so a component moved between the
      // two does not need its import paths rewritten.
      [
        'module-resolver',
        {
          alias: {
            '@classroom/contracts': '../../packages/contracts/src',
            '@classroom/core-client': '../../packages/core-client/src',
            '@classroom/ui-tokens': '../../packages/ui-tokens/src',
          },
        },
      ],
      // react-native-reanimated's plugin must stay last if it is ever added.
    ],
  };
};
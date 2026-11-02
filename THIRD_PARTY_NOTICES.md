# 第三方项目与资源说明

本文件记录当前已核实的来源和仍需核对的资源，不能代替完整的许可证审计。
再分发代码、音频、图片、字体或其他素材前，应分别确认其适用的授权和署名要求。

## 项目上游

- 本仓库是 [XCQ0607/lxserver](https://github.com/XCQ0607/lxserver) 的非官方 Fork。
- 上游说明其项目修改自 [lyswhut/lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)，Web 播放器逻辑参考 [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)。感谢相关作者与贡献者。
- 仓库保留了根目录的 `LICENSE`、`public/LICENSE` 和 `public/music/LICENSE`，以及 README 中的上游补充说明。各文件既有的版权署名不因本 Fork 的修改而改变。

## Font Awesome Free

`public/music/assets/fontawesome/` 包含 Font Awesome Free 6.4.0。其 CSS 文件头注明：图标采用 CC BY 4.0，字体采用 SIL OFL 1.1，代码采用 MIT License。具体范围与条件参见 [Font Awesome Free License](https://fontawesome.com/license/free)。

## 仍需核对的资源

- `src/modules/utils/musicSdk/kg/vendors/infSign.min.js` 为上游包含的文件，其具体来源和再分发授权尚未在本仓库中核实。
- `public/music/assets/medias/filters/` 中的音效文件由上游带入，其具体来源和各自许可尚未核实。
- npm 依赖、容器系统包、自定义音源脚本及其他外部素材，应按实际分发版本分别核查；本文件并非其完整清单。

项目代码的许可证不自动授予音乐、歌词、封面及音乐平台数据的使用或再分发权利。

# Model and library credits

历史版本采用 Quaternius 的三个犬模型，经过本地 Blender V4 流程整理为网页 GLB。2026-10-08 的 2D 版已改用原创分层矢量角色，主页不再请求下列犬 GLB；旧文件保留用于回滚，其许可如下：

| 文件 | 原作及来源 | 许可 |
|---|---|---|
| public/assets/models/dog_shiba.glb | [Shiba Inu — Quaternius](https://poly.pizza/m/y4wdQpg767) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| public/assets/models/dog_husky.glb | [Husky — Quaternius](https://poly.pizza/m/wcWiuEqwzq) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| public/assets/models/dog_pug.glb | [Characters Pug — Quaternius](https://poly.pizza/m/xvcUwuKl4c) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

巴哥所对应的作者素材包页面另标 CC0，本交付保守遵从本次下载页的 CC BY 3.0，保留署名、原作链接、许可链接及修改说明。

修改内容：安全合并法线拆分顶点、静态细分与插值蒙皮权重整理、尺寸/材质显示统一、骨骼动作烘焙及动作命名整理；柴犬和哈士奇各保留12原生动作＋新增4头颈动作，巴哥保留11原生动作＋新增5头颈动作。本版新增网页点选、完整动作队列、寻路、地面高度与场景照明。原作者不对本项目背书。

原始下载 GLB 和完整来源哈希记录保存在此前交付的 ConsensusBell-V4 包；本前端包包含可直接运行的改作 GLB，正常运行不依赖 V4。

房屋 home-room.glb 来自同一 V4 小屋基底，转换曲线并按材质合并静态几何；省略 Blender 专用微观织物 bump。原始产品设计与纪念物素材沿用用户提供项目。

Three.js 0.186.1（MIT）：[官方项目](https://github.com/mrdoob/three.js)，许可随附 public/vendor/three/LICENSE。本地模块包括 renderer/core、GLTFLoader、BufferGeometryUtils 和 SkeletonUtils。

设计参考：[Stitch / Live2D Dog UI Design](https://stitch.withgoogle.com/projects/14136255929140024860)，采用用户授权读取的设计规范与首页/选犬截图作为实现参考；未复制登录页 HTML 或远程脚本。

再次分发时请一并保留本文件、public/assets/models/ATTRIBUTION.txt 和 Three.js 许可。

## 2026-10-08 原创 2D 小狗与16动效

当前角色绘制源为 `public/room/dog2d-art.js`，动画引擎为 `public/room/dog2d.js`。柴犬、哈士奇、巴哥均由 Canvas2D 路径、分层部件和实时姿态参数绘制，不包含第三方照片贴图，不再使用旧 GLB 的骨骼或动作。

16动效：待机呼吸、眨眼、摇尾、行走、奔跑、跳跃、坐下、趴下、睡觉、伸懒腰、挥爪、开心比心、左歪头、右歪头、点头、张望。房屋与 Three.js 保留原来源，2D 角色作为透明朝向相机的精灵置入原小屋。

此前图片搜索的造型参考：[圆脸柴犬](https://maruone.com/blog/entry/41832)、[Reza Sohani 的哈士奇幼犬](https://unsplash.com/photos/a-puppy-with-blue-eyes-sitting-on-a-white-surface-Utuk7nlcNRA)、[Warren Photographic 巴哥幼犬](https://www.warrenphotographic.co.uk/37789-fawn-pug-pup-8-weeks-old-portrait)。这些照片只用于观察比例、面罩与耳形，没有打包为应用资源。

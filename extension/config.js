// 构建期烤死的后端地址(用户无需填写)。
// 本地开发改成:http://localhost:8000
window.HG_CONFIG = {
  backend: "https://www.deuce.monster/htmlgenius",
  // Google OAuth Web client(launchWebAuthFlow 隐式 id_token 流用;aud 校验)
  google_client_id: "1056915339056-tbf5eiroh5f7gjjrigmnfduiieqq4h24.apps.googleusercontent.com",
  // GA4 埋点(注册资产后填;空 = 跳过 GA 直发,只走自建后端)。api_secret 随扩展分发属公开值(spec 已接受)。
  ga_measurement_id: "",
  ga_api_secret: "",
};

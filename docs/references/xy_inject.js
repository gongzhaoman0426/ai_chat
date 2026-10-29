/**
 * 核心功能：从 Webpack 模块系统中提取聊天 SDK 和相关容器 SDK
 */
  function extractImSdk() {
    // 获取 Webpack 的 chunk 对象
    const webpackChunk = window.webpackChunk_ice_lite_scaffold;
    
    if (!isWebpackChunk(webpackChunk)) {
      throw new Error("`window.webpackChunk_ice_lite_scaffold` 不是有效的 WebpackChunk 对象");
    }
  
    try {
      // 获取 Webpack 的 require 函数
      const webpackRequire = captureWebpackRequire(webpackChunk);
      window.webpackRequire = webpackRequire
      console.log("匹配到 WebpackRequire:", webpackRequire);
  
      // 查找符合条件的聊天模块
      const chatModule = findModuleByCondition(
        webpackRequire,
        (moduleId, moduleFactory) => validateModuleSignature(moduleFactory)
      );
      console.log("匹配到聊天 SDK 模块:", chatModule);
  
      //验证模块结构并提取 SDK
      const validatedSdk = validateChatModuleStructure(chatModule);
      if (!validatedSdk) {
        throw new Error("聊天 SDK 结构验证失败");
      }
      console.log("验证通过的聊天 SDK:", validatedSdk);
      return {
        chatSdk: validatedSdk,
      };
    } catch (error) {
      throw new Error("聊天 SDK 提取失败", { cause: error });
    }
  }
  
  /* ========== 工具函数 ========== */
  
  /** 检查是否为有效的 Webpack chunk 对象 */
  function isWebpackChunk(target) {
    return !!(target && typeof target.push === "function");
  }
  
  /**
   * 通过注入临时模块捕获 Webpack 的 require 函数
   * 原理：利用 Webpack JSONP 回调机制
   */
  function captureWebpackRequire(chunk) {
    let capturedRequire;
    
    // 注入临时模块来捕获 require 函数
    chunk.push([
      [Math.random()],          // 随机模块 ID
      {},                       // 空模块对象
      (requireFunction) => {    // 回调函数捕获 require
        capturedRequire = requireFunction;
      }
    ]);
  
    if (!capturedRequire) {
      throw new Error("无法获取 WebpackRequire，请检查 WebpackJsonp 状态");
    }
    return capturedRequire;
  }
  
  /** 根据条件查找模块 */
  function findModuleByCondition(webpackRequire, conditionChecker) {
    // 遍历所有注册的模块
    for (const [moduleIdStr, moduleFactory] of Object.entries(webpackRequire.m)) {
      const moduleId = Number(moduleIdStr);
      if (conditionChecker(moduleId, moduleFactory)) {
        // var p = {
        //     id: moduleId,
        //     loaded: false,
        //     exports: {}
        // };
        // return webpackRequire[moduleId].call(p.exports, p, p.exports, webpackRequire);
        return webpackRequire(moduleId); // 加载并返回匹配的模块
      }
    }
    throw new Error("未找到符合要求的模块");
  }
  
  /** 验证模块签名（示例正则列表） */
  const MODULE_SIGNATURE_PATTERNS = [/getInstance\s*/, /getMessageService\s*/, /getUserId\s*/, /getSessionService\s*/, /getStore\s*/, /getUserService\s*/, /getEngine\s*/, /_instance\s*/];
  
  /** 验证模块工厂函数是否符合预期特征 */
  function validateModuleSignature(moduleFactory) {
    const moduleCode = moduleFactory.toString();
    return MODULE_SIGNATURE_PATTERNS.every(pattern => 
      pattern.test(moduleCode)
    );
  }
  
  /** 验证聊天 SDK 结构完整性 */
  function validateChatModuleStructure(module) {
    if (!isObject(module)) return false;
    const singleton  = module.h.getInstance();
    try{
    // 核心功能检查
    if(isFunction(singleton.getMessageService) &&
          isFunction(singleton.getUserId) &&
          // 生命周期方法
          isFunction(singleton.getSessionService) &&
          isFunction(singleton.getUserService) &&
          isFunction(singleton.getEngine))
        return singleton
    }
    catch{
       return false;
    }
  }
  
  /* ========== 类型检查工具 ========== */
  const isObject = obj => !!obj && typeof obj === "object";
  const isFunction = fn => typeof fn === "function";

 window._imsdk = extractImSdk();
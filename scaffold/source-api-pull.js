#!/usr/bin/env node
/**
 * source-api-pull.js - 从线上拉取 API（完全覆盖本地）
 *
 * 用法: node source-api-pull.js [api-id]
 *
 * 参数:
 *   api-id     - API ID 或目录 ID
 *                如果是目录 ID，则拉取该目录及目录下的所有 API
 *                如果是 API ID，则只拉取该 API
 *
 * 当 API 所属的父目录在本地不存在时，自动拉取父目录
 *
 * 示例:
 *   node source-api-pull.js 123456
 *   node source-api-pull.js abc123
 *
 * 环境变量:
 *   SERVER_URL   - 服务器地址 (默认: http://localhost:8080)
 *   USERNAME     - 用户名
 *   PASSWORD     - 密码
 *   PROJECT_UUID - 项目 UUID
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const utils = require('./utils');

// 加载 .env 环境变量
utils.loadEnv();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const PROJECT_UUID = process.env.PROJECT_UUID || '';
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';

const apiId = process.argv[2];

// 判断是否是拉取所有 API
const pullAll = apiId === '-a';

if (!pullAll && !apiId) {
    console.error('❌ 错误: 请提供 API ID 或使用 -a 拉取所有 API');
    console.error('');
    console.error('用法:');
    console.error('  node source-api-pull.js <api-id>   # 拉取单个 API 或目录');
    console.error('  node source-api-pull.js -a          # 拉取所有 API');
    console.error('');
    console.error('示例:');
    console.error('  node source-api-pull.js 123456');
    console.error('  node source-api-pull.js -a');
    process.exit(1);
}

// 确定项目目录
let projectDir;
if (PROJECT_UUID) {
    projectDir = path.join(__dirname, PROJECT_UUID);
} else {
    // 尝试从 manifest.json 获取
    const dirs = fs.readdirSync(__dirname);
    for (const dir of dirs) {
        const manifestPath = path.join(__dirname, dir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (manifest.projectUuid) {
                    projectDir = path.join(__dirname, dir);
                    break;
                }
            } catch (e) {
                // 跳过
            }
        }
    }
}

if (!projectDir || !fs.existsSync(projectDir)) {
    console.error('❌ 错误: 项目目录不存在');
    console.error('请确保在 .env 中配置了 PROJECT_UUID，或先运行 source-pull.js');
    process.exit(1);
}

const apisDir = path.join(projectDir, 'apis');

// Cookie 存储
let cookieString = '';

// 缓存数据
let directoryList = [];
let apiList = [];

async function login() {
    console.log('[1/4] 登录...');
    const loginUrl = `${SERVER_URL}/youyaboot-admin/magical_lowcode/server/web/login`;

    try {
        const response = await axios.post(loginUrl, {
            userName: USERNAME,
            password: PASSWORD
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // 从响应头中提取 cookie
        const setCookie = response.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
            cookieString = setCookie.map(c => c.split(';')[0]).join('; ');
        }

        if (response.data && (response.data.code === 0 || response.data.code === 200 || response.data.flag === true)) {
            console.log('✓ 登录成功');
            return true;
        } else {
            console.error(`✗ 登录失败: ${JSON.stringify(response.data)}`);
            return false;
        }
    } catch (error) {
        console.error(`✗ 登录失败: ${error.message}`);
        return false;
    }
}

// 获取目录列表
async function fetchDirectoryList() {
    const url = `${SERVER_URL}/youyaboot-admin/api/directory/list?projectId=${PROJECT_UUID}`;
    console.log(`  调试: 请求 directory/list 接口: ${url}`);

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieString
            }
        });

        if (response.data && (response.data.code === 0 || response.data.code === 200)) {
            directoryList = response.data.data || [];
            console.log(`  调试: directory/list 返回 ${directoryList.length} 个目录`);
            return directoryList;
        } else {
            console.error(`  调试: directory/list 返回错误: ${JSON.stringify(response.data)}`);
            return [];
        }
    } catch (error) {
        console.error(`  调试: directory/list 请求失败: ${error.message}`);
        return [];
    }
}

// 获取 API 列表
async function fetchApiList() {
    const url = `${SERVER_URL}/youyaboot-admin/api/api-list?isDb=false&projectId=${PROJECT_UUID}`;
    console.log(`  调试: 请求 api-list 接口: ${url}`);

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieString
            }
        });

        if (response.data && (response.data.code === 0 || response.data.code === 200)) {
            apiList = response.data.data || [];
            console.log(`  调试: api-list 返回 ${apiList.length} 个 API`);
            return apiList;
        } else {
            console.error(`  调试: api-list 返回错误: ${JSON.stringify(response.data)}`);
            return [];
        }
    } catch (error) {
        console.error(`  调试: api-list 请求失败: ${error.message}`);
        return [];
    }
}

// 根据 id 查找目录
function findDirectoryById(id) {
    return directoryList.find(d => String(d.id) === String(id));
}

// 根据 directoryId 查找 API
function findApiById(id) {
    return apiList.find(a => String(a.id) === String(id));
}

// 收集后代目录 id
function collectDescendantDirIds(parentId) {
    const result = [];
    const stack = [parentId];
    while (stack.length > 0) {
        const currentId = stack.pop();
        const children = directoryList.filter(d => d.parentId && String(d.parentId) === String(currentId));
        for (const child of children) {
            result.push(child.id);
            stack.push(child.id);
        }
    }
    return result;
}

// 判断目标是目录还是 API
function determineTarget() {
    // 先尝试作为目录查找
    const dir = findDirectoryById(apiId);
    if (dir) {
        return { isDirectory: true, target: dir };
    }

    // 再尝试作为 API 查找
    const api = findApiById(apiId);
    if (api) {
        return { isDirectory: false, target: api };
    }

    return null;
}

// 构建目录的完整路径
function buildDirPath(dir) {
    const parts = [];
    let current = dir;
    while (current) {
        // 替换 Windows 不支持的字符
        const safeName = current.name.replace(/[<>:"/\\|?*]/g, '_');
        parts.unshift(safeName);
        current = current.parentId ? findDirectoryById(current.parentId) : null;
    }
    return parts.join('/');
}

// 递归删除目录
async function deleteDirectoryRecursive(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            await deleteDirectoryRecursive(itemPath);
        } else {
            fs.unlinkSync(itemPath);
        }
    }

    fs.rmdirSync(dirPath);
}

// 复制目录内容
function copyDir(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return;

    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    const items = fs.readdirSync(srcDir);
    for (const item of items) {
        const srcPath = path.join(srcDir, item);
        const destPath = path.join(destDir, item);
        const stat = fs.statSync(srcPath);

        if (stat.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// 写入 JSON 文件
function writeJson(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// 写入文本文件
function writeText(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
}

// 拉取目录
async function pullDirectory(dir, allDirIds) {
    const dirPath = path.join(apisDir, buildDirPath(dir));
    console.log(`  调试: 拉取目录 ${dir.name}, 路径: ${dirPath}`);

    // 创建目录
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    // 写入目录 meta.json
    writeJson(path.join(dirPath, 'meta.json'), dir);

    // 收集该目录下的所有 API
    const dirApis = apiList.filter(a => a.directoryId && String(a.directoryId) === String(dir.id));
    for (const api of dirApis) {
        // 替换 Windows 不支持的字符
        const safeApiName = api.name.replace(/[<>:"/\\|?*]/g, '_');
        const apiPath = path.join(dirPath, safeApiName);
        if (!fs.existsSync(apiPath)) {
            fs.mkdirSync(apiPath, { recursive: true });
        }

        // 写入 API meta.json（只包含基本信息，不包含 script）
        const apiMeta = { ...api };
        delete apiMeta.script;
        writeJson(path.join(apiPath, 'meta.json'), apiMeta);

        // 如果有 script，写入 script.js
        if (api.script) {
            writeText(path.join(apiPath, 'script.js'), api.script);
        }

        console.log(`  调试:   写入 API ${api.name}`);
    }

    // 递归处理子目录
    const childDirs = directoryList.filter(d => d.parentId && String(d.parentId) === String(dir.id));
    for (const childDir of childDirs) {
        if (allDirIds.includes(childDir.id)) {
            await pullDirectory(childDir, allDirIds);
        }
    }
}

// 递归确保祖先目录存在并写入 meta.json
function ensureAncestorDirs(dir) {
    if (!dir || !dir.parentId) return;

    const parentDir = findDirectoryById(dir.parentId);
    if (parentDir) {
        // 递归处理更上层的目录
        ensureAncestorDirs(parentDir);

        // 确保父目录存在
        const parentPath = path.join(apisDir, buildDirPath(parentDir));
        if (!fs.existsSync(parentPath)) {
            fs.mkdirSync(parentPath, { recursive: true });
        }
        // 写入父目录的 meta.json
        writeJson(path.join(parentPath, 'meta.json'), parentDir);
    }
}

// 拉取单个 API
async function pullApi(api) {
    const parentDir = findDirectoryById(api.directoryId);

    // 递归确保所有祖先目录存在
    if (parentDir) {
        ensureAncestorDirs(parentDir);
    }

    let parentPath = apisDir;

    if (parentDir) {
        parentPath = path.join(apisDir, buildDirPath(parentDir));
        // 确保父目录存在并写入父目录的 meta.json
        if (!fs.existsSync(parentPath)) {
            fs.mkdirSync(parentPath, { recursive: true });
        }
        // 写入父目录的 meta.json
        writeJson(path.join(parentPath, 'meta.json'), parentDir);
    }

    // 替换 Windows 不支持的字符
    const safeApiName = api.name.replace(/[<>:"/\\|?*]/g, '_');
    const apiPath = path.join(parentPath, safeApiName);
    console.log(`  调试: 拉取 API ${api.name}, 路径: ${apiPath}`);

    // 确保 API 目录存在
    if (!fs.existsSync(apiPath)) {
        fs.mkdirSync(apiPath, { recursive: true });
    }

    // 写入 API meta.json
    const apiMeta = { ...api };
    delete apiMeta.script;
    writeJson(path.join(apiPath, 'meta.json'), apiMeta);

    // 如果有 script，写入 script.js
    if (api.script) {
        writeText(path.join(apiPath, 'script.js'), api.script);
    }
}

async function main() {
    console.log('========================================');
    console.log('  拉取 API (完全覆盖本地)');
    console.log('========================================');
    console.log(`服务器地址: ${SERVER_URL}`);
    console.log(`项目目录:  ${projectDir}`);
    console.log(`API ID:    ${apiId}`);
    console.log('========================================');
    console.log('');

    try {
        // 确保 apis 目录存在
        if (!fs.existsSync(apisDir)) {
            fs.mkdirSync(apisDir, { recursive: true });
        }

        // 步骤 1: 登录
        const loginSuccess = await login();
        if (!loginSuccess) {
            process.exit(1);
        }

        // 步骤 2: 获取目录和 API 列表
        console.log('');
        console.log('[2/4] 获取目录和 API 列表...');
        await fetchDirectoryList();
        await fetchApiList();

        if (directoryList.length === 0 && apiList.length === 0) {
            console.error('✗ 错误: 无法获取目录和 API 数据');
            process.exit(1);
        }

        // 步骤 3: 确定目标
        console.log('');
        console.log('[3/4] 确定拉取目标...');

        if (pullAll) {
            console.log('✓ 拉取模式: 所有 API');

            // 收集所有目录 id（用于判断哪些是子目录）
            const allDirIds = directoryList.map(d => d.id);

            // 找出所有根目录（没有父目录的）
            const rootDirs = directoryList.filter(d => !d.parentId || d.parentId === '');

            console.log(`✓ 目录数量: ${directoryList.length}`);
            console.log(`✓ API 数量: ${apiList.length}`);

            // 拉取所有根目录
            for (const rootDir of rootDirs) {
                const dirAllIds = [rootDir.id, ...collectDescendantDirIds(rootDir.id)];
                await pullDirectory(rootDir, dirAllIds);
            }

            // 拉取所有不在目录树中的 API（直接挂在根目录下的 API）
            const apiDirIds = new Set(directoryList.map(d => d.id));
            const orphanApis = apiList.filter(a => !a.directoryId || !apiDirIds.has(a.directoryId));
            for (const api of orphanApis) {
                await pullApi(api);
            }

        } else {
            const targetInfo = determineTarget();

            if (!targetInfo) {
                console.error(`✗ 错误: 找不到 ID=${apiId} 的目录或 API`);
                process.exit(1);
            }

            const { isDirectory, target } = targetInfo;
            console.log(`✓ 目标类型: ${isDirectory ? '目录' : 'API'}`);
            console.log(`✓ 目标名称: ${target.name}`);

            if (isDirectory) {
                // 拉取目录：收集所有后代目录
                const allDirIds = [target.id, ...collectDescendantDirIds(target.id)];
                console.log(`✓ 需要拉取的目录数量: ${allDirIds.length}`);

                // 扫描本地已有的目录
                const existingDirs = utils.scanMetaFiles(apisDir);

                // 检查父目录是否存在
                let currentDir = target;
                while (currentDir && currentDir.parentId) {
                    const localParentExists = existingDirs.some(d => String(d.id) === String(currentDir.parentId) || String(d.meta.id) === String(currentDir.parentId));
                    if (!localParentExists) {
                        // 父目录不存在，需要先拉取父目录
                        const parentDir = findDirectoryById(currentDir.parentId);
                        if (parentDir) {
                            console.log(`  调试: 父目录 ${parentDir.name} 不存在，需要先拉取`);
                            const parentAllDirIds = [parentDir.id, ...collectDescendantDirIds(parentDir.id)];
                            await pullDirectory(parentDir, parentAllDirIds);
                        }
                    }
                    currentDir = findDirectoryById(currentDir.parentId);
                }

                // 拉取目标目录
                await pullDirectory(target, allDirIds);

            } else {
                // 拉取单个 API
                await pullApi(target);
            }
        }

        console.log('');
        console.log('========================================');
        console.log('✅ 拉取成功!');
        console.log('========================================');
        console.log('');
        console.log('提示: 本地 API 已完全被线上版本覆盖');
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 拉取失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();

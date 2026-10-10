#!/usr/bin/env node
/**
 * source-page-pull.js - 从线上拉取页面（完全覆盖本地）
 *
 * 用法: node source-page-pull.js [page-uuid]
 *
 * 参数:
 *   page-uuid  - 页面 UUID 或目录 UUID
 *                如果是目录 UUID，则拉取该目录及目录下的所有页面
 *                如果是页面 UUID，则只拉取该页面
 *
 * 示例:
 *   node source-page-pull.js abc123
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
const unzipper = require('unzipper');
const utils = require('./utils');

// 加载 .env 环境变量
utils.loadEnv();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const PROJECT_UUID = process.env.PROJECT_UUID || '';
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';

const pageUuid = process.argv[2];

// 判断是否是拉取所有页面
const pullAll = pageUuid === '-a';

if (!pullAll && !pageUuid) {
    console.error('❌ 错误: 请提供页面 UUID 或使用 -a 拉取所有页面');
    console.error('');
    console.error('用法:');
    console.error('  node source-page-pull.js <page-uuid>   # 拉取单个页面或目录');
    console.error('  node source-page-pull.js -a              # 拉取所有页面');
    console.error('');
    console.error('示例:');
    console.error('  node source-page-pull.js abc123');
    console.error('  node source-page-pull.js -a');
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

const pagesDir = path.join(projectDir, 'pages');

// Cookie 存储
let cookieString = '';

// 缓存页面树
let pageTree = [];

async function login() {
    console.log('[1/5] 登录...');
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

        if (response.data && (response.data.code === 0 || response.data.code === 200)) {
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

// 获取页面树
async function fetchPageTree() {
    const url = `${SERVER_URL}/youyaboot-admin/magicalcoder/user/project/page-tree?projectUuid=${PROJECT_UUID}`;
    console.log(`  调试: 请求 page-tree 接口: ${url}`);

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieString
            }
        });

        if (response.data && (response.data.code === 0 || response.data.code === 200)) {
            pageTree = response.data.data || [];
            console.log(`  调试: page-tree 返回 ${pageTree.length} 个节点`);
            console.log(`  调试: page-tree 完整数据: ${JSON.stringify(pageTree, null, 2)}`);
            return pageTree;
        } else {
            console.error(`  调试: page-tree 返回错误: ${JSON.stringify(response.data)}`);
            return [];
        }
    } catch (error) {
        console.error(`  调试: page-tree 请求失败: ${error.message}`);
        return [];
    }
}

// 在树中查找节点
function findNodeByUuid(nodes, uuid) {
    for (const node of nodes) {
        if (node.uuid === uuid) {
            return node;
        }
        if (node.children && node.children.length > 0) {
            const found = findNodeByUuid(node.children, uuid);
            if (found) return found;
        }
    }
    return null;
}

// 查找祖先路径（从根到目标，通过遍历树结构）
function findAncestorPath(uuid) {
    const path = [];

    function traverse(nodes, currentPath) {
        for (const node of nodes) {
            // 添加当前节点到路径
            currentPath.push(node);

            if (node.uuid === uuid) {
                // 找到目标，复制路径（不包含目标自身）
                for (const n of currentPath.slice(0, -1)) {
                    path.push(n);
                }
                return true;
            }

            // 在子节点中查找
            if (node.children && node.children.length > 0) {
                if (traverse(node.children, currentPath)) {
                    return true;
                }
            }

            // 回溯
            currentPath.pop();
        }
        return false;
    }

    traverse(pageTree, []);
    return path;
}

// 判断目标是目录还是页面
function determineTarget() {
    const node = findNodeByUuid(pageTree, pageUuid);
    if (!node) {
        return null;
    }
    return {
        isDirectory: node.dir === true,
        node: node
    };
}

// 统计节点数量
function countNodes(nodes) {
    let count = 0;
    for (const node of nodes) {
        count++;
        if (node.children && node.children.length > 0) {
            count += countNodes(node.children);
        }
    }
    return count;
}

// 递归拉取节点（用于拉取所有页面）
async function pullNode(node) {
    if (node.dir === true) {
        // 是目录，递归处理子节点
        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                await pullNode(child);
            }
        }
    } else {
        // 是页面，下载并处理
        const zipPath = await downloadPage(node.uuid);
        if (zipPath) {
            const tempExtractDir = await extractZip(zipPath, node.uuid);
            if (tempExtractDir) {
                // 构建祖先目录
                const ancestorPath = findAncestorPath(node.uuid);
                if (ancestorPath.length > 0) {
                    await buildAncestorDirs(ancestorPath);
                }

                // 找到解压后的页面目录
                const extractedItems = fs.readdirSync(tempExtractDir);
                let sourceDir = tempExtractDir;

                for (const item of extractedItems) {
                    const itemPath = path.join(tempExtractDir, item);
                    const stat = fs.statSync(itemPath);

                    if (stat.isDirectory()) {
                        const pageJsonPath = path.join(itemPath, 'page.json');
                        if (fs.existsSync(pageJsonPath)) {
                            sourceDir = itemPath;
                            break;
                        }
                    }
                }

                // 复制页面内容
                const pageDestPath = path.join(pagesDir, ...ancestorPath.map(n => n.name), node.name);
                if (fs.existsSync(pageDestPath)) {
                    await deleteDirectoryRecursive(pageDestPath);
                }
                fs.mkdirSync(pageDestPath, { recursive: true });

                copyDir(sourceDir, pageDestPath, (json) => {
                    return {
                        uuid: json.uuid,
                        name: json.name
                    };
                });

                console.log(`✓ 已拉取页面: ${ancestorPath.length > 0 ? ancestorPath.map(n => n.name).join('/') + '/' : ''}${node.name}`);

                // 清理临时目录
                await deleteDirectoryRecursive(tempExtractDir);
                fs.unlinkSync(zipPath);
            }
        }
    }
}

async function downloadPage(downloadUuid) {
    console.log('');
    console.log('[3/5] 从服务器下载页面...');
    const zipPath = path.join(projectDir, `.temp-page-${downloadUuid}.zip`);
    const downloadUrl = `${SERVER_URL}/youyaboot-admin/magicalcoder/user/project/page-export?projectUuid=${PROJECT_UUID}&pageUuid=${downloadUuid}`;

    try {
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            headers: {
                'Cookie': cookieString
            },
            responseType: 'arraybuffer'
        });

        // 检查返回的是否是 JSON 错误响应
        const buffer = Buffer.from(response.data);
        if (buffer.length > 0) {
            // 检查是否是 ZIP 文件 (PK 头: 0x50 0x4B)
            if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
                // 可能是 JSON 错误响应
                try {
                    const text = buffer.toString('utf-8');
                    console.error(`✗ 服务器返回: ${text}`);
                    const json = JSON.parse(text);
                    console.error(`✗ 下载失败: ${JSON.stringify(json)}`);
                    return null;
                } catch (e) {
                    console.error(`✗ 服务器返回: ${buffer.toString('utf-8').substring(0, 500)}`);
                    console.error(`✗ 下载失败: 返回了非 ZIP 格式数据`);
                    return null;
                }
            }
        }

        if (!response.data || buffer.length === 0) {
            console.error('✗ 下载失败: 返回为空');
            return null;
        }

        fs.writeFileSync(zipPath, buffer);

        const fileSize = buffer.length;
        const fileSizeStr = fileSize > 1024 * 1024
            ? `${(fileSize / 1024 / 1024).toFixed(2)} MB`
            : `${(fileSize / 1024).toFixed(2)} KB`;
        console.log(`✓ 页面已下载: ${fileSizeStr}`);
        return zipPath;
    } catch (error) {
        console.error(`✗ 下载失败: ${error.message}`);
        return null;
    }
}

async function extractZip(zipPath, extractUuid) {
    console.log('');
    console.log('[4/5] 解压...');

    const tempExtractDir = path.join(projectDir, `.temp-extract-page-${extractUuid}`);

    try {
        // 清理旧临时目录
        if (fs.existsSync(tempExtractDir)) {
            await deleteDirectoryRecursive(tempExtractDir);
        }
        fs.mkdirSync(tempExtractDir, { recursive: true });

        // 使用 unzipper 解压 - 需要等待所有文件写入完成
        const pendingEntries = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                    const filePath = path.join(tempExtractDir, entry.path);
                    const directory = path.dirname(filePath);

                    if (!fs.existsSync(directory)) {
                        fs.mkdirSync(directory, { recursive: true });
                    }

                    if (entry.type === 'Directory') {
                        fs.mkdirSync(filePath, { recursive: true });
                        entry.autodrain();
                    } else {
                        const writeStream = fs.createWriteStream(filePath);
                        entry.pipe(writeStream);

                        // 跟踪每个文件写入完成
                        pendingEntries.push(new Promise((res) => {
                            writeStream.on('finish', res);
                            writeStream.on('error', res);
                        }));
                    }
                })
                .on('close', async () => {
                    // 等待所有文件写入完成
                    await Promise.all(pendingEntries);
                    resolve();
                })
                .on('error', reject);
        });

        console.log('✓ 解压完成');
        return tempExtractDir;
    } catch (error) {
        console.error(`✗ 解压失败: ${error.message}`);
        return null;
    }
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

// 复制目录内容，可选过滤 JSON 文件
function copyDir(srcDir, destDir, filterJson) {
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
            copyDir(srcPath, destPath, filterJson);
        } else {
            // 如果配置了 JSON 过滤函数
            if (filterJson && item === 'page.json') {
                try {
                    const content = fs.readFileSync(srcPath, 'utf-8');
                    const json = JSON.parse(content);
                    const filtered = filterJson(json);
                    fs.writeFileSync(destPath, JSON.stringify(filtered, null, 2), 'utf-8');
                } catch (e) {
                    fs.copyFileSync(srcPath, destPath);
                }
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
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

// 构建祖先目录（只创建目录和简单的 page.json）
async function buildAncestorDirs(ancestorPath) {
    for (const ancestor of ancestorPath) {
        const dirPath = path.join(pagesDir, ...ancestorPath.slice(0, ancestorPath.indexOf(ancestor) + 1).map(n => n.name));

        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // 写入简单的 page.json（只包含 uuid, name, dir: true）
        const pageJsonPath = path.join(dirPath, 'page.json');
        if (!fs.existsSync(pageJsonPath)) {
            writeJson(pageJsonPath, {
                uuid: ancestor.uuid,
                name: ancestor.name,
                dir: true
            });
        }
    }
}

async function main() {
    console.log('========================================');
    console.log('  拉取页面 (完全覆盖本地)');
    console.log('========================================');
    console.log(`服务器地址: ${SERVER_URL}`);
    console.log(`项目目录:  ${projectDir}`);
    console.log(`页面 UUID: ${pageUuid}`);
    console.log('========================================');
    console.log('');

    try {
        // 确保 pages 目录存在
        if (!fs.existsSync(pagesDir)) {
            fs.mkdirSync(pagesDir, { recursive: true });
        }

        // 步骤 1: 登录
        const loginSuccess = await login();
        if (!loginSuccess) {
            process.exit(1);
        }

        // 步骤 2: 获取页面树
        console.log('');
        console.log('[2/5] 获取页面信息...');
        await fetchPageTree();

        if (pullAll) {
            // 拉取所有页面
            console.log('✓ 拉取模式: 所有页面');
            console.log(`✓ 页面/目录数量: ${countNodes(pageTree)}`);

            // 遍历所有根节点，拉取目录
            for (const rootNode of pageTree) {
                await pullNode(rootNode);
            }

        } else {
            // 步骤 3: 确定目标
            const targetInfo = determineTarget();

            if (!targetInfo) {
                console.error(`✗ 错误: 找不到 UUID=${pageUuid} 的页面或目录`);
                process.exit(1);
            }

            const { isDirectory, node: targetNode } = targetInfo;
            console.log(`✓ 目标类型: ${isDirectory ? '目录' : '页面'}`);
            console.log(`✓ 目标名称: ${targetNode.name}`);

            // 步骤 4: 下载页面
            const zipPath = await downloadPage(pageUuid);
            if (!zipPath) {
                process.exit(1);
            }

            // 步骤 5: 解压并覆盖本地
            const tempExtractDir = await extractZip(zipPath, pageUuid);
            if (!tempExtractDir) {
                process.exit(1);
            }

            // 扫描解压后的内容，找到实际的页面目录
            const extractedItems = fs.readdirSync(tempExtractDir);
            let sourceDir = null;

            for (const item of extractedItems) {
                const itemPath = path.join(tempExtractDir, item);
                const stat = fs.statSync(itemPath);

                if (stat.isDirectory()) {
                    const pageJsonPath = path.join(itemPath, 'page.json');
                    if (fs.existsSync(pageJsonPath)) {
                        sourceDir = itemPath;
                        break;
                    }
                }
            }

            if (!sourceDir) {
                sourceDir = tempExtractDir;
            }

            if (isDirectory) {
                // 拉取目录：完全覆盖，过滤 page.json 只保留 uuid, name, dir
                const localDir = path.join(pagesDir, targetNode.name);

                if (fs.existsSync(localDir)) {
                    await deleteDirectoryRecursive(localDir);
                }
                fs.mkdirSync(localDir, { recursive: true });
                copyDir(sourceDir, localDir, (json) => {
                    if(json.dir) {
                        return {
                            uuid: json.uuid,
                            name: json.name,
                            dir: json.dir
                        };
                    }
                    return {
                        uuid: json.uuid,
                        name: json.name
                    };
                });
                console.log(`✓ 已覆盖目录: ${targetNode.name}`);

            } else {
                // 拉取单个页面

                // 1. 构建祖先目录
                const ancestorPath = findAncestorPath(pageUuid);
                if (ancestorPath.length > 0) {
                    console.log(`  调试: 构建 ${ancestorPath.length} 个祖先目录`);
                    await buildAncestorDirs(ancestorPath);
                }

                // 2. 找到解压后的页面目录并覆盖
                const pageName = targetNode.name;
                const pageDestPath = path.join(pagesDir, ...ancestorPath.map(n => n.name), pageName);

                if (fs.existsSync(pageDestPath)) {
                    await deleteDirectoryRecursive(pageDestPath);
                }
                fs.mkdirSync(pageDestPath, { recursive: true });

                // 3. 复制页面内容，过滤 page.json 只保留 uuid 和 name
                copyDir(sourceDir, pageDestPath, (json) => {
                    return {
                        uuid: json.uuid,
                        name: json.name
                    };
                });

                console.log(`✓ 已覆盖页面: ${ancestorPath.length > 0 ? ancestorPath.map(n => n.name).join('/') + '/' : ''}${pageName}`);
            }

            // 清理临时目录
            await deleteDirectoryRecursive(tempExtractDir);
            fs.unlinkSync(zipPath);
        }

        console.log('');
        console.log('========================================');
        console.log('✅ 拉取成功!');
        console.log('========================================');
        console.log('');
        console.log('提示: 本地页面已完全被线上版本覆盖');
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 拉取失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();

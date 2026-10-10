#!/usr/bin/env node
/**
 * source-page-push.js - 推送页面到线上
 *
 * 用法: node source-page-push.js [page-uuid]
 *
 * 参数:
 *   page-uuid  - 页面 UUID 或目录 UUID
 *                如果是目录 UUID，则推送该目录及目录下的所有页面
 *                如果是页面 UUID，则只推送该页面
 *                使用 -a 推送所有页面
 *
 * 示例:
 *   node source-page-push.js abc123          # 推送单个页面
 *   node source-page-push.js -a              # 推送所有页面
 *
 * 环境变量:
 *   SERVER_URL   - 服务器地址 (默认: http://localhost:8080)
 *   USERNAME     - 用户名
 *   PASSWORD     - 密码
 *   PROJECT_UUID - 项目 UUID
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const axios = require('axios');
const utils = require('./utils');

// 加载 .env 环境变量
utils.loadEnv();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const PROJECT_UUID = process.env.PROJECT_UUID || '';
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';

const pageUuid = process.argv[2];

// 判断是否是推送所有页面
const pushAll = pageUuid === '-a';

if (!pushAll && !pageUuid) {
    console.error('❌ 错误: 请提供页面 UUID 或使用 -a 推送所有页面');
    console.error('');
    console.error('用法:');
    console.error('  node source-page-push.js <page-uuid>   # 推送单个页面或目录');
    console.error('  node source-page-push.js -a              # 推送所有页面');
    console.error('');
    console.error('示例:');
    console.error('  node source-page-push.js abc123');
    console.error('  node source-page-push.js -a');
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


// 准备页面：将 html、css、javascript 合并到 page.json
function preparePage(pageDir) {
    const pageJsonPath = path.join(pageDir, 'page.json');
    const htmlFile = path.join(pageDir, 'index.html');
    const cssFile = path.join(pageDir, 'page.css');
    const jsFile = path.join(pageDir, 'page.js');

    if (!fs.existsSync(pageJsonPath)) {
        return null;
    }

    try {
        const pageData = JSON.parse(fs.readFileSync(pageJsonPath, 'utf-8'));

        // 读取 html、css、js 并合并到 pageData
        if (fs.existsSync(htmlFile)) {
            pageData.html = fs.readFileSync(htmlFile, 'utf-8');
        }
        if (fs.existsSync(cssFile)) {
            pageData.css = fs.readFileSync(cssFile, 'utf-8');
        }
        if (fs.existsSync(jsFile)) {
            pageData.javascript = fs.readFileSync(jsFile, 'utf-8');
        }

        // 写回 page.json
        fs.writeFileSync(pageJsonPath, JSON.stringify(pageData, null, 2), 'utf-8');
        return pageData;
    } catch (error) {
        console.error(`  错误: 准备页面失败 ${pageDir}: ${error.message}`);
        return null;
    }
}

// 扫描并准备所有页面
function prepareAllPages(scanDir, relativePath = '') {
    const prepared = [];

    if (!fs.existsSync(scanDir)) {
        return prepared;
    }

    const items = fs.readdirSync(scanDir);

    for (const item of items) {
        const itemPath = path.join(scanDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            const pageJsonPath = path.join(itemPath, 'page.json');
            const currentRelativePath = relativePath ? `${relativePath}/${item}` : item;

            if (fs.existsSync(pageJsonPath)) {
                // 这是一个页面目录，准备它
                const result = preparePage(itemPath);
                if (result) {
                    console.log(`  准备页面: ${currentRelativePath}`);
                    prepared.push({ path: itemPath, relativePath: currentRelativePath });
                }
            }

            // 递归扫描子目录
            const childPrepared = prepareAllPages(itemPath, currentRelativePath);
            prepared.push(...childPrepared);
        }
    }

    return prepared;
}

// 还原页面（将备份的 page.json 恢复）
function restorePage(pageDir) {
    const pageJsonPath = path.join(pageDir, 'page.json');
    const htmlFile = path.join(pageDir, 'index.html');
    const cssFile = path.join(pageDir, 'page.css');
    const jsFile = path.join(pageDir, 'page.js');

    if (!fs.existsSync(pageJsonPath)) {
        return;
    }

    try {
        const pageData = JSON.parse(fs.readFileSync(pageJsonPath, 'utf-8'));

        // 分离出 html、css、javascript 到独立文件
        if (pageData.html) {
            fs.writeFileSync(htmlFile, pageData.html, 'utf-8');
            delete pageData.html;
        }
        if (pageData.css) {
            fs.writeFileSync(cssFile, pageData.css, 'utf-8');
            delete pageData.css;
        }
        if (pageData.javascript) {
            fs.writeFileSync(jsFile, pageData.javascript, 'utf-8');
            delete pageData.javascript;
        }

        // 写回 page.json（只保留简单字段）
        const simplePageData = {
            uuid: pageData.uuid,
            name: pageData.name,
            dir: pageData.dir
        };
        fs.writeFileSync(pageJsonPath, JSON.stringify(simplePageData, null, 2), 'utf-8');
    } catch (error) {
        // 忽略错误
    }
}

// 扫描并还原所有页面
function restoreAllPages(scanDir) {
    if (!fs.existsSync(scanDir)) {
        return;
    }

    const items = fs.readdirSync(scanDir);

    for (const item of items) {
        const itemPath = path.join(scanDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            const pageJsonPath = path.join(itemPath, 'page.json');

            if (fs.existsSync(pageJsonPath)) {
                // 这是一个页面目录，还原它
                restorePage(itemPath);
            }

            // 递归还原子目录
            restoreAllPages(itemPath);
        }
    }
}

// 创建 ZIP 包
function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            resolve(outputPath);
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

async function main() {
    console.log('========================================');
    console.log('  推送页面到线上');
    console.log('========================================');
    console.log(`服务器地址: ${SERVER_URL}`);
    console.log(`项目目录:  ${projectDir}`);
    console.log(`页面 UUID: ${pushAll ? '(所有页面)' : pageUuid}`);
    console.log('========================================');
    console.log('');

    let tempDir = null;

    try {
        // 检查 pages 目录
        if (!fs.existsSync(pagesDir)) {
            console.error('❌ 错误: pages 目录不存在');
            process.exit(1);
        }

        // 步骤 1: 登录
        console.log('[1/5] 登录...');
        
        // Cookie 存储
        let cookieString = '';
        
        try {
            const loginResponse = await axios.post(`${SERVER_URL}/youyaboot-admin/magical_lowcode/server/web/login`, {
                userName: USERNAME,
                password: PASSWORD
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            // 从响应头中提取 cookie
            const setCookie = loginResponse.headers['set-cookie'];
            if (setCookie && Array.isArray(setCookie)) {
                cookieString = setCookie.map(c => c.split(';')[0]).join('; ');
            }

            if (loginResponse.data && (loginResponse.data.code === 0 || loginResponse.data.flag === true)) {
                console.log('✓ 登录成功');
            } else {
                console.error(`✗ 登录失败: ${JSON.stringify(loginResponse.data)}`);
                process.exit(1);
            }
        } catch (error) {
            console.error(`✗ 登录失败: ${error.message}`);
            process.exit(1);
        }

        // 步骤 2: 确定要推送的目标
        console.log('');
        console.log('[2/5] 确定推送目标...');

        let targetPath;
        let targetUuid;

        if (pushAll) {
            targetPath = pagesDir;
            targetUuid = ''; // 推送所有
            console.log('✓ 推送模式: 所有页面');
            console.log(`✓ 目标路径: ${targetPath}`);
        } else {
            // 扫描找到目标页面
            const existingPages = utils.scanPageFiles(pagesDir);
            console.log(`  调试: 扫描到 ${existingPages.length} 个页面/目录`);
            for (const p of existingPages) {
                console.log(`  调试:   - uuid=${p.uuid}, name=${p.name}, dir=${p.isDir}`);
            }

            const targetPage = existingPages.find(p => p.uuid === pageUuid || (p.pageData && p.pageData.uuid === pageUuid));

            if (!targetPage) {
                console.error(`✗ 错误: 找不到页面 (uuid: ${pageUuid})`);
                process.exit(1);
            }

            targetPath = targetPage.dirPath;
            targetUuid = targetPage.pageData ? targetPage.pageData.uuid : (targetPage.uuid || '');
            console.log(`✓ 找到页面: ${targetPage.path || targetPage.name}`);
            console.log(`✓ 目标路径: ${targetPath}`);
            console.log(`✓ 目标 UUID: ${targetUuid}`);
        }

        // 步骤 3: 准备页面（合并 html/css/js 到 page.json）
        console.log('');
        console.log('[3/5] 准备页面...');

        tempDir = path.join(projectDir, `.temp_page_push_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // 创建临时 pages 目录
        const tempPagesDir = path.join(tempDir, 'pages');
        fs.mkdirSync(tempPagesDir, { recursive: true });

        // 复制并准备页面
        function copyAndPreparePage(srcPageDir, destPageDir, relativePath) {
            if (!fs.existsSync(srcPageDir)) return;

            fs.mkdirSync(destPageDir, { recursive: true });

            const pageJsonPath = path.join(srcPageDir, 'page.json');
            const htmlFile = path.join(srcPageDir, 'index.html');
            const cssFile = path.join(srcPageDir, 'page.css');
            const jsFile = path.join(srcPageDir, 'page.js');

            console.log(`  准备页面: ${relativePath}`);

            // 读取并合并到 pageData
            const pageData = JSON.parse(fs.readFileSync(pageJsonPath, 'utf-8'));

            if (fs.existsSync(htmlFile)) {
                pageData.html = fs.readFileSync(htmlFile, 'utf-8');
            }
            if (fs.existsSync(cssFile)) {
                pageData.css = fs.readFileSync(cssFile, 'utf-8');
            }
            if (fs.existsSync(jsFile)) {
                pageData.javascript = fs.readFileSync(jsFile, 'utf-8');
            }

            // 写入合并后的 page.json
            fs.writeFileSync(path.join(destPageDir, 'page.json'), JSON.stringify(pageData, null, 2), 'utf-8');
        }

        // 递归复制目录下的所有页面
        function copyAllPages(srcDir, destDir, relativePath = '') {
            if (!fs.existsSync(srcDir)) return;

            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                const srcItemPath = path.join(srcDir, item);
                const destItemPath = path.join(destDir, item);
                const stat = fs.statSync(srcItemPath);

                if (stat.isDirectory()) {
                    const pageJsonPath = path.join(srcItemPath, 'page.json');
                    const currentRelativePath = relativePath ? `${relativePath}/${item}` : item;

                    if (fs.existsSync(pageJsonPath)) {
                        // 这是一个页面目录，复制并准备
                        copyAndPreparePage(srcItemPath, destItemPath, currentRelativePath);
                    }

                    // 递归处理子目录
                    copyAllPages(srcItemPath, destItemPath, currentRelativePath);
                }
            }
        }

        // 检查目标路径是否直接是一个页面目录（有 page.json）
        const targetPageJsonPath = path.join(targetPath, 'page.json');
        if (fs.existsSync(targetPageJsonPath)) {
            // targetPath 直接是一个页面目录
            console.log(`  调试: targetPath 是页面目录，直接复制`);

            // 复制到 tempPagesDir 下的页面名称子目录
            const pageName = path.basename(targetPath);
            const destPageDir = path.join(tempPagesDir, pageName);
            copyAndPreparePage(targetPath, destPageDir, pageName);

            // 如果是目录（dir: true），递归复制所有子页面
            const targetPageData = JSON.parse(fs.readFileSync(targetPageJsonPath, 'utf-8'));
            if (targetPageData.dir === true) {
                console.log(`  调试: 目标是一个目录，递归复制子页面`);
                copyAllPages(targetPath, destPageDir, pageName);
            }
        } else {
            // targetPath 是 pages 目录或普通目录，需要遍历
            copyAllPages(targetPath, tempPagesDir);
        }
        console.log('✓ 页面准备完成');

        // 调试：检查临时目录内容
        console.log('  调试: 临时目录内容:');
        function printDir(dir, prefix = '') {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    console.log(`  ${prefix}${item}/`);
                    printDir(itemPath, prefix + '  ');
                } else {
                    const size = stat.size;
                    console.log(`  ${prefix}${item} (${size} bytes)`);
                }
            }
        }
        printDir(tempPagesDir);

        // 步骤 4: 打包为 ZIP
        console.log('');
        console.log('[4/5] 打包页面...');

        const tempZipPath = path.join(projectDir, `.temp-push-page-${Date.now()}.zip`);
        await createZip(tempPagesDir, tempZipPath);

        const fileSize = fs.statSync(tempZipPath).size;
        const fileSizeStr = fileSize > 1024 * 1024
            ? `${(fileSize / 1024 / 1024).toFixed(2)} MB`
            : `${(fileSize / 1024).toFixed(2)} KB`;
        console.log(`✓ 已打包: ${fileSizeStr}`);

        // 步骤 5: 上传到服务器
        console.log('');
        console.log('[5/5] 上传到服务器...');

        const importUrl = `${SERVER_URL}/youyaboot-admin/magicalcoder/user/project/page-import?projectUuid=${PROJECT_UUID}&pageUuid=${targetUuid || ''}`;

        // 使用 axios 上传文件
        const formData = new (require('form-data'))();
        formData.append('file', fs.createReadStream(tempZipPath));

        const uploadResponse = await axios.post(importUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'Cookie': cookieString
            }
        });

        // 清理临时文件
        fs.unlinkSync(tempZipPath);
        fs.rmdirSync(tempDir, { recursive: true });

        const result = uploadResponse.data;
        if (result.code === 0 || result.flag === true) {
            console.log('✓ 上传成功');
        } else {
            console.error(`✗ 上传失败: ${result.msg || JSON.stringify(result)}`);
            process.exit(1);
        }



        console.log('');
        console.log('========================================');
        console.log('✅ 推送成功!');
        console.log('========================================');
        console.log('');
        console.log('提示: 线上的页面代码已更新');
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 推送失败:', error.message);

        // 清理临时目录
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmdirSync(tempDir, { recursive: true });
        }
        process.exit(1);
    }
}

main();

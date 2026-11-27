#!/usr/bin/env ruby
# frozen_string_literal: true

# 把 Swift 桥接文件装进 `tauri ios init` 生成的 Xcode 工程（桌面歌词 + 灵动岛），
# 并现场创建灵动岛 Live Activity 的 **Widget 扩展 target**。
#
# 为什么必须有这一步：
#   1. Rust 侧用 dlsym 调 Swift 用 `@_cdecl` 导出的符号（shuyin_pip_set /
#      shuyin_island_set 等），这些符号必须真的编进主 App 二进制，否则两个开关
#      永远是哑的。而 `gen/apple` 每次 CI 都从零生成、也不在版本库里，
#      所以只能每次构建后重新装一遍。
#   2. iOS 规定 Live Activity 的 UI 必须放在 WidgetKit 扩展 target 里
#      （ActivityConfiguration 在主 App 里编不过）。扩展 target 同样只能
#      在这里现场建（xcodeproj gem 建 target + 嵌进主 App 的 PlugIns）。
#
# 两种工程格式都要兼容：
#   · Xcode 16 的 PBXFileSystemSynchronizedRootGroup —— 目录里的文件自动参与
#     编译，拷进去就行，**绝对不能**再往 Sources 阶段塞一遍（会重复符号）
#   · 传统 PBXGroup —— 文件在磁盘上不等于在工程里，必须显式 add_file_references
#
# 用法：ruby install-swift.rb <gen/apple 目录>

require 'fileutils'

# 编进主 App 的桥接文件（Rust dlsym 的落点）
FILES = %w[
  ShuyinLyricsPiP.swift
  ShuyinIsland.swift
  IslandAttributes.swift
].freeze

# Widget 扩展 target 的源文件（IslandAttributes.swift 与主 App 各编一份）
EXT_NAME = 'ShuyinIsland'
EXT_DIR = 'IslandWidget'
EXT_FILES = %w[
  IslandWidget.swift
  IslandAttributes.swift
].freeze
EXT_DEPLOYMENT_TARGET = '16.2'

SRC_DIR = __dir__

apple_dir = File.expand_path(ARGV[0] || abort('用法: ruby install-swift.rb <gen/apple 目录>'))
pbx = Dir.glob(File.join(apple_dir, '**', 'project.pbxproj')).first
abort("[swift] 找不到 project.pbxproj: #{apple_dir}") unless pbx

# pbx 位于 <root>/xxx.xcodeproj/ 里面：往上一层是工程包，再上一层才是模板根（gen/apple）。
# 之前只往上取了一层，于是「源码目录」被算成 xxx.xcodeproj/Sources，而且
# Xcodeproj::Project.open 收到的是 project.pbxproj **文件**（它要的是 .xcodeproj
# 目录），CI 上直接抛 "plist ... project.pbxproj/project.pbxproj doesn't exist"。
xcodeproj = File.dirname(pbx)
proj_dir = File.dirname(xcodeproj)
text = File.read(pbx, encoding: 'UTF-8')
puts "[swift] project: #{pbx}"
puts "[swift] template root: #{proj_dir}"
puts "[swift] root children: #{Dir.children(proj_dir).sort.inspect}"

# ---- 1. 判断工程格式，算出该把文件放到哪个目录 ----
dirs = []
if text.include?('PBXFileSystemSynchronizedRootGroup')
  # 从 pbxproj 文本里抠出同步目录的 path（不依赖 xcodeproj 是否认识这个新 isa）
  text.scan(/isa = PBXFileSystemSynchronizedRootGroup;(.*?)\n\t\t\};/m) do |m|
    if m[0] =~ /path = "?([^";\n]+)"?;/
      dirs << Regexp.last_match(1).strip
    end
  end
  puts "[swift] synchronized root groups: #{dirs.inspect}"
end

# 同步组里可能混着 Assets.xcassets / Frameworks 这类，只留源码目录
dirs.reject! { |d| d.include?('.') || d.end_with?('/Frameworks') }
dirs.uniq!

# Sources 是 Tauri 模板的常规源码目录，一并作为候选（不存在就新建）
candidates = dirs.dup
candidates << 'Sources' if candidates.empty?

targets = candidates.map { |d| File.join(proj_dir, d) }
puts "[swift] swift -> #{targets.inspect}"

FILES.each do |f|
  src = File.join(SRC_DIR, f)
  abort("[swift] 缺文件: #{src}") unless File.exist?(src)
end

targets.each do |dir|
  next if dir.end_with?('/Frameworks')
  FileUtils.mkdir_p(dir)
  FILES.each { |f| FileUtils.cp(File.join(SRC_DIR, f), File.join(dir, f)) }
end

# ---- 2. 传统格式：还得登记到 target 的 Sources 编译阶段 ----
if dirs.empty?
  begin
    require 'xcodeproj'
  rescue LoadError
    abort('[swift] 需要 xcodeproj gem：gem install xcodeproj --no-document')
  end

  project = Xcodeproj::Project.open(xcodeproj)
  app = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
  abort('[swift] 找不到主 App target') unless app
  puts "[swift] app target: #{app.name}"

  registered = 0
  FILES.each do |f|
    next if app.source_build_phase.files_references.any? { |r| r.path.to_s.end_with?(f) }
    ref = project.main_group.new_reference(File.join(targets.first, f))
    app.add_file_references([ref])
    registered += 1
    puts "[swift] registered #{f}"
  end
  project.save if registered.positive?
  puts "[swift] project saved (#{registered} 个新文件)"
else
  puts '[swift] synchronized project：拷进目录即自动编译，未改动 pbxproj'
end

# ---- 3. Widget 扩展 target（灵动岛 Live Activity 的 UI 只能在这里） ----

# 扩展目录 + Info.plist（NSExtensionPointIdentifier 是 WidgetKit 扩展的身份证）
ext_dir = File.join(proj_dir, EXT_DIR)
FileUtils.mkdir_p(ext_dir)
File.write(File.join(ext_dir, 'Info.plist'), <<~PLIST)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
      <key>CFBundleDisplayName</key>
      <string>疏音</string>
      <key>CFBundleExecutable</key>
      <string>$(EXECUTABLE_NAME)</string>
      <key>CFBundleIdentifier</key>
      <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
      <key>CFBundleName</key>
      <string>$(PRODUCT_NAME)</string>
      <key>CFBundlePackageType</key>
      <string>$(PRODUCT_TYPE)</string>
      <key>CFBundleShortVersionString</key>
      <string>1.0</string>
      <key>CFBundleVersion</key>
      <string>1</string>
      <key>NSExtension</key>
      <dict>
          <key>NSExtensionPointIdentifier</key>
          <string>com.apple.widgetkit-extension</string>
      </dict>
  </dict>
  </plist>
PLIST
EXT_FILES.each { |f| FileUtils.cp(File.join(SRC_DIR, f), File.join(ext_dir, f)) }

begin
  require 'xcodeproj'
rescue LoadError
  abort('[swift] 需要 xcodeproj gem：gem install xcodeproj --no-document')
end

project = Xcodeproj::Project.open(xcodeproj)
app = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort('[swift] 找不到主 App target') unless app
puts "[swift] app target: #{app.name}"

if project.targets.any? { |t| t.name == EXT_NAME }
  puts "[swift] 扩展 #{EXT_NAME} 已存在，跳过创建"
else
  # 注意：new_target 的 type 必须传符号(:app_extension)，xcodeproj 内部按
  # Constants::PRODUCT_TYPE_UTI[type] 查表——传字符串查不到、product_type 落成
  # nil，Xcode 16 构建服务加载 PIF 时报 "productTypeIdentifier is missing"。
  ext = project.new_target(:app_extension, EXT_NAME, :ios, EXT_DEPLOYMENT_TARGET)
  if ext.product_type.to_s.empty?
    ext.product_type = 'com.apple.product-type.app-extension'
  end
  abort("[swift] 扩展 target product_type 未设上（#{EXT_NAME}）") if ext.product_type.to_s.empty?

  bundle_id = app.build_configurations
                  .map { |bc| bc.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] }
                  .compact.first || 'cn.shuyin.player'

  ext.build_configurations.each do |bc|
    bc.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = "#{bundle_id}.island"
    bc.build_settings['INFOPLIST_FILE'] = "#{EXT_DIR}/Info.plist"
    bc.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
    bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = EXT_DEPLOYMENT_TARGET
    bc.build_settings['TARGETED_DEVICE_FAMILY'] = '1'
    bc.build_settings['SWIFT_VERSION'] = '5.0'
    bc.build_settings['CURRENT_PROJECT_VERSION'] = '1'
    bc.build_settings['MARKETING_VERSION'] = '1.0'
    bc.build_settings['SKIP_INSTALL'] = 'YES'
    bc.build_settings['CODE_SIGN_STYLE'] = 'Manual'
    bc.build_settings['LD_RUNPATH_SEARCH_PATHS'] =
      '"$(inherited)" "@executable_path/Frameworks" "@executable_path/../../Frameworks"'
  end

  # 扩展自己的源文件（IslandAttributes.swift 是共享定义，主 App 那份单独拷）
  refs = EXT_FILES.map { |f| project.main_group.new_reference(File.join(ext_dir, f)) }
  ext.add_file_references(refs)
  puts "[swift] 扩展源文件: #{EXT_FILES.join(', ')}"

  # 依赖 + 嵌进主 App 的 PlugIns（dst_subfolder_spec 13 = PlugIns）
  app.add_dependency(ext)
  embed = app.copy_files_build_phases.find { |p| p.files_references.any? { |r| r.path.to_s.end_with?('.appex') } }
  unless embed
    embed = project.new(Xcodeproj::Project::Object::PBXCopyFilesBuildPhase)
    embed.name = 'Embed Foundation Extensions'
    embed.dst_subfolder_spec = '13'
    app.build_phases << embed
  end
  bf = embed.add_file_reference(ext.product_reference)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy', 'CodeSignOnCopy'] }
  puts "[swift] 扩展已嵌入主 App（bundle id: #{bundle_id}.island）"

  project.save
  puts '[swift] project saved（扩展 target 已创建）'
end

# ---- 4. 回读校验 ----
targets.each do |dir|
  next if dir.end_with?('/Frameworks')
  FILES.each do |f|
    abort("[swift] 拷完却找不到: #{File.join(dir, f)}") unless File.exist?(File.join(dir, f))
  end
end
EXT_FILES.each do |f|
  abort("[swift] 扩展缺文件: #{File.join(ext_dir, f)}") unless File.exist?(File.join(ext_dir, f))
end
abort("[swift] 扩展缺 Info.plist") unless File.exist?(File.join(ext_dir, 'Info.plist'))
puts '[swift] ok'

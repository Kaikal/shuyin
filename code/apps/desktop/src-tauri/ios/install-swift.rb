#!/usr/bin/env ruby
# frozen_string_literal: true

# 把 Live Activity 的 Swift 桥接文件装进 `tauri ios init` 生成的 Xcode 工程。
#
# 为什么必须有这一步：
#   Rust 侧用 dlsym 调 Swift 用 `@_cdecl` 导出的符号（shuyin_live_sync 等），
#   这些符号必须真的编进主 App 二进制，否则灵动岛永远是哑的。而 `gen/apple`
#   每次 CI 都从零生成、也不在版本库里，所以只能每次构建后重新装一遍。
#
# 两种工程格式都要兼容：
#   · Xcode 16 的 PBXFileSystemSynchronizedRootGroup —— 目录里的文件自动参与
#     编译，拷进去就行，**绝对不能**再往 Sources 阶段塞一遍（会重复符号）
#   · 传统 PBXGroup —— 文件在磁盘上不等于在工程里，必须显式 add_file_references
#
# 用法：ruby install-swift.rb <gen/apple 目录>

require 'fileutils'

FILES = %w[
  ShuyinLiveActivity.swift
  ShuyinActivityAttributes.swift
  ShuyinIntents.swift
].freeze

SRC_DIR = __dir__

apple_dir = ARGV[0] or abort('用法: ruby install-swift.rb <gen/apple 目录>')
pbx = Dir.glob(File.join(apple_dir, '**', 'project.pbxproj')).first
abort("[live] 找不到 project.pbxproj: #{apple_dir}") unless pbx

proj_dir = File.dirname(pbx)
text = File.read(pbx, encoding: 'UTF-8')
puts "[live] project: #{pbx}"

# ---- 1. 判断工程格式，算出该把文件放到哪个目录 ----
dirs = []
if text.include?('PBXFileSystemSynchronizedRootGroup')
  # 从 pbxproj 文本里抠出同步目录的 path（不依赖 xcodeproj 是否认识这个新 isa）
  text.scan(/isa = PBXFileSystemSynchronizedRootGroup;(.*?)\n\t\t\};/m) do |m|
    if m[0] =~ /path = "?([^";\n]+)"?;/
      dirs << Regexp.last_match(1).strip
    end
  end
  puts "[live] synchronized root groups: #{dirs.inspect}"
end

# 同步组里可能混着 Assets.xcassets / Frameworks 这类，只留源码目录
dirs.reject! { |d| d.include?('.') || d.end_with?('/Frameworks') }
dirs.uniq!

# Sources 是 Tauri 模板的常规源码目录，一并作为候选（不存在就新建）
candidates = dirs.dup
candidates << 'Sources' if candidates.empty?

targets = candidates.map { |d| File.join(proj_dir, d) }
puts "[live] swift -> #{targets.inspect}"

FILES.each do |f|
  src = File.join(SRC_DIR, f)
  abort("[live] 缺文件: #{src}") unless File.exist?(src)
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
    abort('[live] 需要 xcodeproj gem：gem install xcodeproj --no-document')
  end

  project = Xcodeproj::Project.open(pbx)
  app = project.targets.find { |t| t.product_type == 'com.apple.product-type.application' }
  abort('[live] 找不到主 App target') unless app
  puts "[live] app target: #{app.name}"

  registered = 0
  FILES.each do |f|
    next if app.source_build_phase.files_references.any? { |r| r.path.to_s.end_with?(f) }
    ref = project.main_group.new_reference(File.join(targets.first, f))
    app.add_file_references([ref])
    registered += 1
    puts "[live] registered #{f}"
  end
  project.save if registered.positive?
  puts "[live] project saved (#{registered} 个新文件)"
else
  puts '[live] synchronized project：拷进目录即自动编译，未改动 pbxproj'
end

# ---- 3. 回读校验 ----
targets.each do |dir|
  next if dir.end_with?('/Frameworks')
  FILES.each do |f|
    abort("[live] 拷完却找不到: #{File.join(dir, f)}") unless File.exist?(File.join(dir, f))
  end
end
puts '[live] ok'

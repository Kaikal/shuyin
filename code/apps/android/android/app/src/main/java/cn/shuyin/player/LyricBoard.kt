package cn.shuyin.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import kotlin.math.abs
import kotlin.math.max

/**
 * 两行 KTV 歌词板：悬浮歌词窗和锁屏播放页共用同一套画法。
 *
 * 为什么不用两个 TextView：
 *   · 逐字染色要按**字数比例**切，TextView 只能整段变色；
 *   · 上下两行要按行序奇偶左右互换，两个 TextView 得在布局里 add/remove，
 *     每句都变一次，反而更容易闪。
 * 画布上这些都是一次 drawText 的事，还能顺带把长句缩到一行里放下。
 *
 * 排版对齐电脑端桌面歌词：行序偶数时当前句在左、下一句在右；奇数时对调（斜对角轮换）。
 *
 * **宽度只有一个来源**：`maxWidth`（外层给的排版预算）。onMeasure 和 onDraw 都只用它，
 * 绝不能一个用预算、一个用 `width` —— 那样第一次测量把字截短、截短后的宽度又反过来
 * 当第二次的预算，一句 12 个字会被自己压成 10 个字加省略号（真机上就是这么丢字的）。
 *
 * **这份画法是要跑满 60fps 的**（演唱中金线一直在扫），所以：
 *   · 排版（`fit` / `ellipsize` / `measureText`）只在歌词或宽度变化时算一次，缓存在 [rows] / [shownCur]；
 *   · 颜色写成常量，`Color.parseColor` 不进绘制路径；
 *   · 压暗底的 `LinearGradient` 只在尺寸变化时重建；
 *   · 只有**当前句**带阴影——7 行都带 6dp 模糊等于每帧羽化 7 次，真机上就是掉帧。
 */
class LyricBoard @JvmOverloads constructor(
    ctx: Context,
    attrs: android.util.AttributeSet? = null,
    curSp: Float = 21f,
    nextSp: Float = 13.5f,
) : View(ctx, attrs) {

    /** 排版总宽预算（px，含左右内边距和右上角 × 的让位）。>0 时测量与绘制都以它为准 */
    var maxWidth = 0

    /** 已唱部分的颜色 */
    var hl = HL_DEFAULT
        set(v) {
            field = v
            invalidate()
        }

    /** 底板颜色（悬浮窗薄一点，锁屏厚一点）。改成 0 = 不要底板 */
    var plateColor = Color.argb(118, 12, 14, 22)
        set(v) {
            if (field == v) return
            field = v
            invalidate()
        }

    /** 没有歌词时拿它顶上台（歌名） */
    var fallback = ""
        set(v) {
            if (field == v) return
            field = v
            textDirty = true
            requestLayout()
            invalidate()
        }

    private val curSp0 = curSp
    private val nextSp0 = nextSp

    /**
     * 多行模式（锁屏播放页）。
     *
     * 关着的时候是原来的两行 KTV：悬浮窗就一条小窗，铺五行会把字压成一条缝。
     * 打开之后按 [NowPlaying.around] 铺 7 行，当前句垂直居中，
     * 上下各三条按距离变淡——就是歌词页那种「远近」层次。
     */
    var multi = false

    private var aroundLines: List<String> = emptyList()

    private var cur = ""
    private var next = ""
    private var prog = 0f
    private var flip = false
    /**
     * 未截断的整句。
     *
     * 单行模式（悬浮歌词）里 `shownCur` 是 `fit()` 出来的——超宽就被省略号砍掉尾巴，
     * 拿来跑马灯等于「滚动一个已经被截短的字符串」，滚到底还是缺字。
     * 跑马灯必须按整句画，所以把原文单独留一份。
     */
    private var fullCur = ""

    /*
     * 进度补间：前端 250ms 推一次 prog，直接按推来的值画就是「一格一格蹦」。
     * 这里把上一次的值到这一次的值在一段时间内线性补完，金线才是连续扫过去的。
     *
     * **必须比推送间隔长**（250ms 心跳 → 这里 280ms）。
     * 原来写的是 220ms：每一拍都在「补间跑完」和「下一次推送」之间空了 30ms，
     * 金色停住约两帧再动 —— 就是用户说的「染色总感觉有点卡卡的」。
     * 补间略长于心跳时，金线永远在动，下一次推送在它跑完之前就把它接上；
     * 稳态只落后真实播放位置约 30ms（≈12% 一拍），听感、看感都无差。
     */
    private var progShown = 0f
    private var progFrom = 0f
    private var progTo = 0f
    private var animT0 = 0L
    private var animating = false
    private val animDur = 280f

    /**
     * 上一次收到的**目标**进度（不是补间中的值）。
     *
     * 锁屏页 200ms 刷一次、歌词进度 250ms 推一次，两拍对不齐：每一次「空拍」
     * 都会拿着同一个目标再 `retarget` 一遍，把补间从当前位置重新排到同一个终点。
     * 于是金线越落越远（稳态约落后 100ms），而且一直在重启动画。
     * 目标没变就直接返回，让正在跑的那条补间自己跑完。
     */
    private var progTarget = -1f

    private val d = resources.displayMetrics.density
    private fun dp(v: Float) = v * d

    private val padH = dp(13f)
    private val padV = dp(9f)
    private val gap = dp(5f)
    /** 右上角 × 的让位宽度：文字不能钻到按钮底下（30dp 按钮 + 边距，再留一点空隙） */
    private val closeW = dp(42f)

    private val curPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textSize = dp(curSp0)
        /* 阴影给得比两行模式更厚：锁屏封面明暗不定，字必须自己带一层「底」 */
        setShadowLayer(dp(6f), 0f, dp(1f), Color.argb(235, 0, 0, 0))
    }
    private val nextPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textSize = dp(nextSp0)
        setShadowLayer(dp(3f), 0f, dp(1f), Color.argb(190, 0, 0, 0))
    }

    /**
     * 多行里「不是当前句」的那几行用的笔：同一套字体，**不带走阴影**。
     *
     * 7 行都挂着 6dp 模糊阴影时，每画一帧 Skia 要做 7 次羽化——中端机直接掉到 40fps 以下
     * （用户反馈的「锁屏歌词染色卡卡的、有掉帧感」）。这七行下面本来就有压暗底，
     * 减掉阴影几乎看不出差别，但每帧少 6 次羽化。
     */
    private val dimPaint = TextPaint(curPaint).apply { clearShadowLayer() }

    /**
     * 「已唱」那一层用的笔：**不带走阴影**。
     *
     * 金色是盖在白色正文之上重画一遍的，而它是同一串字、同一个位置 ——
     * 白色那遍已经把带 6dp 模糊的影子完整画出来了，金色再带一层影子，
     * 等于每帧把同一段模糊羽化算两遍。清掉之后画面一模一样，
     * 当前句每帧少一次羽化（真机上这就是那几帧续不上的余量）。
     */
    private val ktvPaint = TextPaint(curPaint).apply { clearShadowLayer() }

    private val plate = Paint(Paint.ANTI_ALIAS_FLAG)

    /** 字体度量（一次算好；字号在构造后不再变，见 [fit]） */
    private val fmCur = Paint.FontMetrics()
    private val fmNext = Paint.FontMetrics()
    /** 行高：descent - ascent */
    private var hCur = 0f
    private var hNext = 0f

    private var shownCur = ""
    private var shownNext = ""
    /** 实际画出来的宽度（截断后） */
    private var curW = 0f
    private var nextW = 0f
    /** 整句（未截断）的宽度：染色进度按整句算，截断时也不会「染得太快」 */
    private var curFullW = 0f

    /**
     * 把染色目标改到 [p]，**从当前真正画到的位置接着走**。
     *
     * 早先这里写的是 `progFrom = progShown`——而 `progShown` 只在补间**跑完**时才更新。
     * 前端 250ms 推一次进度，这条 220ms 的补间经常还没收尾就被下一次推送打断，
     * 于是每次都从同一个旧起点重放一遍：金色在一小段上来回抽，用户看到的就是
     * 「歌词染色会闪」（录屏里最明显的是连续推送之间那几帧）。
     * 现在先算出当前插值到哪儿，再把它当作新起点，接得上、不回退。
     */
    private fun retarget(p: Float) {
        val now = animProg()
        progShown = now
        if (p <= now) {
            /* 往回跳（重播 / 拖动进度）：直接认定，别倒着扫回去 */
            progShown = p
            animating = false
            invalidate()
            return
        }
        progFrom = now
        progTo = p
        animT0 = android.os.SystemClock.uptimeMillis()
        animating = true
        postInvalidateOnAnimation()
    }

    /** 多行模式的入口：整版歌词（当前句居中）+ 本句进度 */
    fun setAround(list: List<String>, p: Float) {
        val textChanged = list != aroundLines
        aroundLines = list
        prog = p.coerceIn(0f, 1f)
        if (textChanged) {
            progShown = prog
            progTarget = prog
            animating = false
            rowsDirty = true
            requestLayout()
            invalidate()
        } else if (prog != progTarget) {
            progTarget = prog
            retarget(prog)
        }
        /* 目标没变就什么都不做：正在跑的那条补间自己会接着把帧排上 */
    }

    /** 多行的一行高：字号的 1.6 倍，七行正好铺满锁屏中部 */
    private fun rowH(): Float = hCur * 1.6f

    fun setLines(c: String, n: String, p: Float, f: Boolean) {
        val textChanged = c != cur || n != next || f != flip
        cur = c
        next = n
        prog = p.coerceIn(0f, 1f)
        flip = f
        if (textChanged) {
            /* 换句才重新量宽度；新句子从头开始，不补间（否则会从上一句的末尾扫回来） */
            progShown = prog
            progTarget = prog
            animating = false
            textDirty = true
            requestLayout()
            invalidate()
        } else if (prog != progTarget) {
            progTarget = prog
            retarget(prog)
        }
    }

    /** 当前该画到哪儿：补间中就按时间插值，顺手把下一帧排上 */
    private fun animProg(): Float {
        if (!animating) return progShown
        val t = (android.os.SystemClock.uptimeMillis() - animT0) / animDur
        if (t >= 1f) {
            progShown = progTo
            animating = false
            return progShown
        }
        postInvalidateOnAnimation()
        return progFrom + (progTo - progFrom) * t
    }

    /* ------------------------------------------------------------------ */
    /* 排版缓存                                                            */
    /* ------------------------------------------------------------------ */

    /** 两行模式的排版是否要重算（换句 / 换预算才置 true） */
    private var textDirty = true
    private var textBudget = 0f

    /**
     * 多行模式下每一行的成品：截断后的文字 + 画出来的宽度 + 整句宽度。
     *
     * 这些值原来是在 `onDraw` 里**每帧**现算的（7 行 × measureText + 可能的 ellipsize），
     * 60fps 下每秒几百次文字测量，外加 ellipsize 的对象分配——这是掉帧的主要来源。
     * 现在只有歌词内容或可用宽度变化时才重建（[ensureRows]）。
     */
    private class Row(val text: String, val w: Float, val fullW: Float)

    private var rows: Array<Row> = emptyArray()
    private var rowsDirty = true
    private var rowsAvail = -1f

    /** 压暗底的着色器：只跟尺寸有关，别每帧新建 */
    private var plateShader: LinearGradient? = null
    private var plateW = -1
    private var plateH = -1

    /** 「板上还没有歌词」时中间那行歌名（缓存，见 drawMulti） */
    private var emptyText = ""
    private var emptyW = 0f
    private var emptySrc = "\u0000"
    private var emptyAvail = -1f

    init {
        curPaint.getFontMetrics(fmCur)
        nextPaint.getFontMetrics(fmNext)
        hCur = fmCur.descent - fmCur.ascent
        hNext = fmNext.descent - fmNext.ascent
    }

    /**
     * 重建多行的排版。
     *
     * 用**脏标记 + 预算比较**，不再每帧拼一个 key 字符串：`drawMulti` 每帧都会调到这里，
     * 拼 7 段字符串等于每秒几百次分配，纯属给 GC 添活。
     *
     * **当前句不截断**：它超宽时要整句留着给 [drawMulti] 做跑马灯（见那里的注释）。
     * 上下那几条只露个大概，截断加省略号反而更干净。
     */
    private fun ensureRows(avail: Float) {
        if (!rowsDirty && avail == rowsAvail) return
        rowsDirty = false
        rowsAvail = avail
        rows = Array(aroundLines.size) { i ->
            val raw = aroundLines[i]
            if (raw.isBlank()) {
                Row("", 0f, 0f)
            } else {
                val fullW = curPaint.measureText(raw)
                if (i == NowPlaying.AROUND_CUR && fullW > avail) {
                    /* 当前句整句留着：宽度也记整句宽，下面的跑马灯按它算偏移 */
                    Row(raw, fullW, fullW)
                } else {
                    val txt = fit(raw, curPaint, avail, curSp0)
                    Row(txt, curPaint.measureText(txt), fullW)
                }
            }
        }
    }

    private fun ensureText(budget: Float) {
        if (!textDirty && budget == textBudget) return
        textDirty = false
        textBudget = budget
        layoutText(budget)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val mode = MeasureSpec.getMode(widthMeasureSpec)
        val spec = MeasureSpec.getSize(widthMeasureSpec).toFloat()
        val budget = budgetOf(spec)
        ensureText(budget)
        if (multi) ensureRows((spec - padH * 2).coerceAtLeast(dp(60f)))
        /*
         * 父容器给的是**死宽**（悬浮窗满屏、锁屏页 match_parent）时，必须原样吃掉这个宽度。
         * 早先这里无脑按内容算 w，结果 MATCH_PARENT 量出来还是「内容宽」——
         * 板子实际只有半屏宽，右对齐那一行就被挤回左边了（真机上看着像两行都靠左）。
         */
        val w = if (mode == MeasureSpec.EXACTLY) {
            spec.toInt()
        } else {
            val contentW = max(curW, nextW)
            (contentW + padH * 2 + closeW).coerceAtMost(budget).toInt()
                .coerceAtLeast(dp(90f).toInt())
        }
        /*
         * 多行模式按内容的固定高度：行数不会因为某句是空行（纯间奏）就变，
         * 否则前后几句一空，整块歌词连带歌名会上下跳。
         *
         * 但父容器给了**死高**（锁屏那片 `0dp + weight=1` 的歌词区）时必须照收：
         * 多出来的部分就是歌词区自己的留白，`drawMulti` 会把当前句画在正中。
         */
        val wantH = if (multi) {
            (rowH() * NowPlaying.AROUND_N).toInt()
        } else {
            (padV * 2 + hCur + if (shownNext.isBlank()) 0f else gap + hNext).toInt()
        }
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) {
            MeasureSpec.getSize(heightMeasureSpec)
        } else {
            wantH
        }
        setMeasuredDimension(w, h)
    }

    /**
     * 按当前数据重新算「实际要画的两行字 + 宽度」。
     *
     * 以前 onDraw 每帧都调它，`fit` 里的 measureText / ellipsize 就跟着每帧跑一遍。
     * 现在由 [ensureText] 按内容变化决定要不要调。
     */
    private fun layoutText(budget: Float) {
        /*
         * 两行的可用宽度不一样：× 只在右上角，所以**上面那行**要给它让位，
         * 下面那行可以直接铺到右内边距。共用一份宽度的话，下排右对齐之后
         * 右边会平白空出一截，浅色壁纸上就是一条不对称的黑边。
         */
        val availTop = (budget - padH * 2 - closeW).coerceAtLeast(dp(60f))
        val availBot = (budget - padH * 2).coerceAtLeast(dp(60f))
        val fullCur = cur.ifBlank { fallback.ifBlank { "疏音" } }
        this.fullCur = fullCur
        shownCur = fit(fullCur, curPaint, if (flip) availBot else availTop, curSp0)
        curW = curPaint.measureText(shownCur)
        curFullW = curPaint.measureText(fullCur)

        shownNext = fit(next, nextPaint, if (flip) availTop else availBot, nextSp0)
        nextW = if (shownNext.isBlank()) 0f else nextPaint.measureText(shownNext)
    }

    /**
     * 多行歌词：当前句在正中间、金色按进度扫过，上下各两条越远越淡。
     *
     * 行高 / 行数都固定（当前句 ±3），换句时整块不会上下跳；
     * 远近只靠 **alpha** 表达，不动字号——字号一变，"第二行"跟着长大，
     * 看着像焦点在换行（用户当初否掉 Folia 就是这个原因）。
     */
    private fun drawMulti(c: Canvas) {
        val list = aroundLines
        val cx = width / 2f
        val cy = height / 2f
        val rh = rowH()
        val avail = (width - padH * 2).coerceAtLeast(dp(60f))

        /*
         * 可读性底：锁屏那张封面经常是**亮色**（白底人像、黄向日葵都会被抽到），
         * 白字直接压上去几乎看不出笔画。原来靠一块 12dp 圆角的实底板撑着，
         * 铺成多行之后那块板会有半屏大，太笨重——这里换成上下羽化的薄暗底：
         * 中间 50% 黑、上下淡出，边界看不出来，只当是环境光压暗。
         */
        if (list.any { it.isNotBlank() }) {
            /* 只压住**文字占的那一条**，不压整个歌词区：这片区域现在被
               weight=1 撑满了，全高压暗会把上半屏糊成一块灰。 */
            val blockH = rh * NowPlaying.AROUND_N
            val top = (height - blockH) / 2f
            /* 尺寸用整数比，别每帧拼一个 "$w/$h" 字符串（见 ensureRows 的注释） */
            if (width != plateW || height != plateH) {
                plateW = width
                plateH = height
                plateShader = LinearGradient(
                    0f, top, 0f, top + blockH,
                    intArrayOf(Color.TRANSPARENT, PLATE_SCUFF, PLATE_SCUFF, Color.TRANSPARENT),
                    floatArrayOf(0f, 0.16f, 0.84f, 1f),
                    Shader.TileMode.CLAMP,
                )
            }
            plate.color = Color.TRANSPARENT
            plate.shader = plateShader
            val rr = dp(20f)
            c.drawRoundRect(-dp(6f), top, width + dp(6f), top + blockH, rr, rr, plate)
            plate.shader = null
        }

        if (list.none { it.isNotBlank() }) {
            /* 还没拿到歌词（或整段是间奏）：中间放歌名。原生侧没有「暂无歌词」
               这种文案入口，写死一句话反而像报错，顶歌名最自然。
               这一段可能一停就是整首前奏，「没歌词」状态下也在按帧重绘，
               所以同样按「内容 / 宽度变了才重算」缓存，别每帧 measureText。 */
            if (avail != emptyAvail || fallback != emptySrc) {
                emptySrc = fallback
                emptyAvail = avail
                emptyText = fit(fallback.ifBlank { "疏音" }, curPaint, avail, curSp0)
                emptyW = curPaint.measureText(emptyText)
            }
            curPaint.color = INK
            c.drawText(emptyText, cx - emptyW / 2f, cy - (fmCur.ascent + fmCur.descent) / 2f, curPaint)
            return
        }

        ensureRows(avail)
        /* 进度只取一次：下面跑马灯的偏移和金色染色必须用同一个值，否则两者会错位 */
        val k = animProg()
        for (i in rows.indices) {
            val row = rows[i]
            /* 间奏那几行是空的：不画字，位置由固定行高撑住，整块不会缩 */
            if (row.text.isEmpty()) continue
            val dd = i - NowPlaying.AROUND_CUR
            val base = cy + dd * rh - (fmCur.ascent + fmCur.descent) / 2f
            if (dd == 0) {
                /*
                 * 当前句：**超宽就跑马灯**（用户要的「唱到这一句时自己滑过去」）。
                 *
                 * 偏移不按时间跑，而是**跟着金线走**：金线扫到窗口 62% 之前不动，
                 * 之后整句往左推，让「正在唱的那几个字」一直留在窗口里，
                 * 唱完那一拍正好把句尾推到窗口右缘（`coerceIn` 到 `over` 收住）。
                 *
                 * 这样它和染色是同一个驱动（[animProg] 的补间），既不会出现
                 * 「字幕在动、金线在另一处」的错位，也不需要在换句时重置任何计时器：
                 * 新句子的 `prog` 从 0 开始，偏移自然回到 0，从头开始显示。
                 */
                val over = row.fullW - avail
                if (over > dp(1f)) {
                    val lead = avail * 0.62f
                    val off = (k * row.fullW - lead).coerceIn(0f, over)
                    val left = cx - avail / 2f
                    c.save()
                    /* 横向裁到窗口内（这里的裁剪会和 drawKtv 内部的竖向裁剪求交） */
                    c.clipRect(
                        left, base + fmCur.ascent - dp(3f),
                        left + avail, base + fmCur.descent + dp(3f),
                    )
                    drawKtv(c, row.text, left - off, base, curPaint, row.fullW, fmCur, k)
                    c.restore()
                } else {
                    drawKtv(c, row.text, cx - row.fullW / 2f, base, curPaint, row.fullW, fmCur, k)
                }
            } else {
                val a = when (abs(dd)) {
                    1 -> 0.52f
                    2 -> 0.28f
                    3 -> 0.14f
                    else -> 0.08f
                }
                dimPaint.color = Color.argb((a * 255).toInt(), 0xF4, 0xF5, 0xF9)
                c.drawText(row.text, cx - row.w / 2f, base, dimPaint)
            }
        }
    }

    override fun onDraw(canvas: Canvas) {
        if (multi) {
            drawMulti(canvas)
            return
        }
        val w = width.toFloat()
        val h = height.toFloat()
        val r = dp(14f)
        if (plateColor != 0) {
            plate.shader = null
            plate.color = plateColor
            canvas.drawRoundRect(0f, 0f, w, h, r, r, plate)
        }

        /* 宽高可能还是上一句量出来的，按同一份预算重算（见类注释） */
        ensureText(budgetOf(w))

        val cm = fmCur
        val nm = fmNext
        val nextH = if (shownNext.isBlank()) 0f else hNext

        /* 当前句 / 下一句谁在上：行序偶数时当前句在上，奇数时换到下排（KTV 轮换） */
        val curTop = if (flip) padV + nextH + gap else padV
        val nextTop = if (flip) padV else padV + hCur + gap
        val curBase = curTop - cm.ascent
        val nextBase = nextTop - nm.ascent

        /* 上排左对齐、下排右对齐（与谁在上无关，跟着「排」走） */
        val left = padH
        val right = w - padH
        val curX = if (flip) (right - curW).coerceAtLeast(left) else left
        val nextX = if (flip) left else (right - nextW).coerceAtLeast(left)

        if (shownNext.isNotBlank()) {
            nextPaint.color = NEXT_INK
            canvas.drawText(shownNext, nextX, nextBase, nextPaint)
        }
        /*
         * 当前句超宽 → **跑马灯**（和锁屏页多行模式同一套公式）。
         *
         * 悬浮歌词的窗宽就是整屏宽，可一句 30 多字照样装不下；以前这里只剩
         * `fit()` 的省略号，用户看到的是「后半句永远不出现」。现在金字扫过窗口
         * 62% 之后整句开始往左推，唱完那一拍正好把句尾送到右缘——
         * 和染色同一个驱动（[animProg]），不会出现「字在动、金线在别处」。
         *
         * 溢出的句子一律从左边起排：右对齐再往左推，一开唱就看不见句首。
         */
        val progNow = animProg()
        val availCur = (budgetOf(w) - padH * 2 - if (flip) 0f else closeW).coerceAtLeast(dp(60f))
        val over = curFullW - availCur
        if (over > dp(1f) && fullCur.isNotBlank()) {
            val lead = availCur * 0.62f
            val off = (progNow * curFullW - lead).coerceIn(0f, over)
            canvas.save()
            /* 横向裁到窗口内（和 drawKtv 内部的竖向裁剪求交） */
            canvas.clipRect(
                left, curBase + cm.ascent - dp(3f),
                left + availCur, curBase + cm.descent + dp(3f),
            )
            drawKtv(canvas, fullCur, left - off, curBase, curPaint, curFullW, cm, progNow)
            canvas.restore()
        } else {
            drawKtv(canvas, shownCur, curX, curBase, curPaint, curFullW, cm, progNow)
        }
    }

    /**
     * 唱到哪儿染到哪儿。
     *
     * **不按字切**：早先是一个字一个字换颜色，配上 250ms 一推的进度，看起来就是
     * 「一卡一卡地蹦字」。现在整行先画白，再按 `prog × 整句宽` 裁一条竖线把金色叠上去——
     * 边界落在字中间也能切开，配合 [animProg] 的补间就是连续扫过的。
     * 只多两次 drawText，比逐字画二十多次还便宜。
     *
     * `fm` 由调用方传入（缓存好的），别在这里读 `paint.fontMetrics`——那每调一次都会
     * 新建一个 FontMetrics 对象，60fps 下就是每秒几十次分配。
     *
     * 金色这一层走 [ktvPaint]（同字号、无阴影）：白色那遍已经把影子画全了，
     * 这里再羽化一次纯属白花钱（见 ktvPaint 的注释）。
     */
    private fun drawKtv(
        c: Canvas,
        text: String,
        x0: Float,
        y: Float,
        p: TextPaint,
        fullW: Float,
        fm: Paint.FontMetrics,
        k: Float,
    ) {
        if (text.isBlank()) return
        p.color = INK
        c.drawText(text, x0, y, p)
        if (k <= 0f) return
        val cut = x0 + fullW * k
        c.save()
        c.clipRect(x0 - dp(2f), y + fm.ascent - dp(2f), cut, y + fm.descent + dp(2f))
        ktvPaint.color = hl
        c.drawText(text, x0, y, ktvPaint)
        c.restore()
        p.color = INK
    }

    private fun budgetOf(fallbackW: Float): Float =
        if (maxWidth > 0) maxWidth.toFloat() else fallbackW.coerceAtLeast(dp(90f))

    /**
     * 字号**恒定**，放不下就截断（2026-11-01 用户定稿：安卓端歌词字号不跟着句子变）。
     *
     * 做过一版按句长缩字号的，看起来每句都在跳，比截断难看得多——
     * 字幕条要的是稳定，长度交给省略号。
     */
    private fun fit(text: String, p: TextPaint, avail: Float, sp: Float): String {
        p.textSize = dp(sp)
        if (text.isBlank()) return ""
        if (p.measureText(text) <= avail) return text
        return TextUtils.ellipsize(text, p, avail, TextUtils.TruncateAt.END).toString()
    }

    private companion object {
        /** 未唱到的字（近白） */
        const val INK = 0xFFF4F5F9.toInt()
        /** 两行模式的次行（比主行暗一档） */
        const val NEXT_INK = 0xFFC6CBD8.toInt()
        /** 多行模式的压暗底：argb(168, 4, 6, 12) */
        const val PLATE_SCUFF = 0xA804060C.toInt()
        /** 「已唱」默认色（流金）；调用方一般会覆盖成用户选的配色 */
        val HL_DEFAULT = Color.parseColor("#FFC94D")
    }
}

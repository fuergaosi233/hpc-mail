/**
 * 1024proxy 公开定价页的节选（结构取自 2026-11-25 的 /pricing/{residential,unlimited,static}/ 页面，价格只是样例）。
 * 保留了真实页面里会干扰解析的细节：跨行属性、HTML 注释、无关的 data-* 标签。
 */

export const RESIDENTIAL_HTML = `
<div class="proxy-resident-content resident-proxys">
  <!-- <img class="maple-leaf-logo" src="/static/common/pricing/img/maple-leaf-logo.png" alt=""> -->
  <div>
    <p class="title">2-100GB</p>
    <p class="price cacle-price">$2.40</p>
    <p class="unlit-price">单价：<span>$1.20/GB</span></p>
    <a href="javascript:;" class="buy-btn" data-sn="flowmax100" data-num="2">
      立即购买 <!-- <img class="spring1" src="/x.png" alt=""> -->
    </a>
    <div class="static-tab-box">
      <div class="calculate-content" data-min="2" data-max="100" data-num="2"
        data-step="1" data-price="1.20" data-unit="GB">
        <input class="register-number" type="text" value="2" />
      </div>
    </div>
  </div>
  <div>
    <p class="title">200GB</p>
    <p class="price ">$140.00</p>
    <a href="javascript:;" class="buy-btn" data-sn="flowmax200" data-num="1">立即购买</a>
    <div class="static-tab-box"><p class="text1 text-value">200</p></div>
  </div>
  <div>
    <p class="conner">优惠70%</p>
    <p class="title">1 TB</p>
    <p class="price ">$490.00</p>
    <a href="javascript:;" class="buy-btn" data-sn="flowmax1tb" data-num="1">立即购买</a>
  </div>
</div>`;

export const UNLIMITED_HTML = `
<div class="proxy-resident-content unlimit-content" style="display: none;">
  <div class="bind-width-content" data-day-text="天" data-hour-text="小时">
    <p class="title">100 Mbps</p>
    <p class="price">$1035.00</p>
    <a href="javascript:;" class="buy-btn" data-type="bandwidth">立即购买</a>
    <div class="dropdown dropdown_bandwidth">
      <ul class="dropdown-menu">
        <li data-value="720" class="active" data-price="34.50"
          data-sn="30D100mRand" data-day="30" data-money="1035.00" data-hour="720">30 天</li>
        <li data-value="3" class="" data-price="7.00"
          data-sn="3H100mRand" data-day="0" data-money="21.60" data-hour="3">3 小时</li>
      </ul>
    </div>
  </div>
  <div class="bind-width-content" data-day-text="天" data-hour-text="小时">
    <p class="conner">最受欢迎</p>
    <p class="title">200 Mbps</p>
    <ul class="dropdown-menu">
      <li data-value="168" class="active" data-price="56.97"
        data-sn="7D200MRand" data-day="7" data-money="398.79" data-hour="168">7 天</li>
    </ul>
  </div>
</div>
<div class="unlimit-content-port">
  <div>
    <p class="title">2-15Ports</p>
    <p class="price">$5.00</p>
    <a href="javascript:;" class="buy-btn" data-type="ports">立即购买</a>
    <div class="port-tab-box">
      <div class="calculate-content unlimit-calculate" data-num="2" data-price="2.50"
        data-step="1" data-min="2" data-max="15">
        <input class="port-number" type="text" value="2" />
      </div>
      <div class="dropdown dropdown_ports">
        <ul class="dropdown-menu">
          <li class="select-item" data-day="3" data-sn="2-15ports3d" data-price="2.50">3 天</li>
          <li class="select-item" data-day="7" data-sn="2-15ports7d" data-price="4.50">7 天</li>
          <li class="select-item" data-day="30" data-sn="2-15ports30d" data-price="15.50">30 天</li>
        </ul>
      </div>
    </div>
  </div>
  <div>
    <p class="title">16-40Ports</p>
    <div class="calculate-content unlimit-calculate" data-num="16" data-price="2.00"
      data-step="2" data-min="16" data-max="40"></div>
    <ul class="dropdown-menu">
      <li class="select-item" data-day="30" data-sn="16-40ports30d" data-price="13.56">30 天</li>
    </ul>
  </div>
</div>`;

export const STATIC_HTML = `
<div class="country_lists_container">
  <div class="country_lists" data-day="7" data-unit="day" style="display: none;">
    <div class="country_lists_detail nativeList" data-region="AS" data-price="1.5"
      data-url="http://static.1024proxy.com/images/country/round/kr.png" data-costprice="1.8" data-code="KR">
      <p class="unit-price">$ 1.5/IP</p>
    </div>
  </div>
  <div class="country_lists" data-day="30" data-unit="day">
    <div class="country_lists_detail nativeList" data-region="AS" data-price="3.0"
      data-url="http://static.1024proxy.com/images/country/round/kr.png" data-costprice="3.4" data-code="KR">
      <!-- <p class="unit_price_selected"></p> -->
      <p class="cost-price">$ 3.4/IP</p>
      <p class="unit-price">$ 3.0/IP</p>
    </div>
    <div class="country_lists_detail" data-region="NA" data-price="2.5" data-costprice="" data-code="US"></div>
    <div class="country_lists_detail" data-region="AS" data-price="3.5" data-costprice="3.9" data-code="MY2"></div>
  </div>
  <div class="country_lists" data-day="90" data-unit="day" style="display: none;">
    <div class="country_lists_detail" data-region="NA" data-price="6.5" data-costprice="7.0" data-code="US"></div>
  </div>
</div>`;

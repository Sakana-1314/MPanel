import{d as ve,cc as ge,cd as we,e as Y,x as o,bB as q,y as A,f as s,D as H,g as me,u as Q,ce as O,o as b,h as C,z as _,j as l,i as r,n as G,p as pe,bj as ye,v as E,r as xe,t as K,B as L,bk as k,k as J,bv as ke,m as Se,bw as Be,aP as S,bu as I,bq as c,C as Ce}from"./index-Dj3udJXr.js";import{u as _e}from"./Alert-Dox5Ojjy.js";function ze(e){const{primaryColor:d,opacityDisabled:f,borderRadius:a,textColor3:v}=e;return{...ge,iconColor:v,textColor:"white",loadingColor:d,opacityDisabled:f,railColor:"rgba(0, 0, 0, .14)",railColorActive:d,buttonBoxShadow:"0 1px 4px 0 rgba(0, 0, 0, 0.3), inset 0 0 1px 0 rgba(0, 0, 0, 0.05)",buttonColor:"#FFF",railBorderRadiusSmall:a,railBorderRadiusMedium:a,railBorderRadiusLarge:a,buttonBorderRadiusSmall:a,buttonBorderRadiusMedium:a,buttonBorderRadiusLarge:a,boxShadowFocus:`0 0 0 2px ${we(d,{alpha:.2})}`}}const $e={common:ve,self:ze};var Re=Y("switch",`
 height: var(--n-height);
 min-width: var(--n-width);
 vertical-align: middle;
 user-select: none;
 -webkit-user-select: none;
 display: inline-flex;
 outline: none;
 justify-content: center;
 align-items: center;
`,[o("children-placeholder",`
 height: var(--n-rail-height);
 display: flex;
 flex-direction: column;
 overflow: hidden;
 pointer-events: none;
 visibility: hidden;
 `),o("rail-placeholder",`
 display: flex;
 flex-wrap: none;
 `),o("button-placeholder",`
 width: calc(1.75 * var(--n-rail-height));
 height: var(--n-rail-height);
 `),Y("base-loading",`
 position: absolute;
 top: 50%;
 left: 50%;
 transform: translateX(-50%) translateY(-50%);
 font-size: calc(var(--n-button-width) - 4px);
 color: var(--n-loading-color);
 transition: color .3s var(--n-bezier);
 `,[q({left:"50%",top:"50%",originalTransform:"translateX(-50%) translateY(-50%)"})]),o("checked, unchecked",`
 transition: color .3s var(--n-bezier);
 color: var(--n-text-color);
 box-sizing: border-box;
 position: absolute;
 white-space: nowrap;
 top: 0;
 bottom: 0;
 display: flex;
 align-items: center;
 line-height: 1;
 `),o("checked",`
 right: 0;
 padding-right: calc(1.25 * var(--n-rail-height) - var(--n-offset));
 `),o("unchecked",`
 left: 0;
 justify-content: flex-end;
 padding-left: calc(1.25 * var(--n-rail-height) - var(--n-offset));
 `),A("&:focus",[o("rail",`
 box-shadow: var(--n-box-shadow-focus);
 `)]),s("round",[o("rail","border-radius: calc(var(--n-rail-height) / 2);",[o("button","border-radius: calc(var(--n-button-height) / 2);")])]),H("disabled",[H("icon",[s("rubber-band",[s("pressed",[o("rail",[o("button","max-width: var(--n-button-width-pressed);")])]),o("rail",[A("&:active",[o("button","max-width: var(--n-button-width-pressed);")])]),s("active",[s("pressed",[o("rail",[o("button","left: calc(100% - var(--n-offset) - var(--n-button-width-pressed));")])]),o("rail",[A("&:active",[o("button","left: calc(100% - var(--n-offset) - var(--n-button-width-pressed));")])])])])])]),s("active",[o("rail",[o("button","left: calc(100% - var(--n-button-width) - var(--n-offset))")])]),o("rail",`
 overflow: hidden;
 height: var(--n-rail-height);
 min-width: var(--n-rail-width);
 border-radius: var(--n-rail-border-radius);
 cursor: pointer;
 position: relative;
 transition:
 opacity .3s var(--n-bezier),
 background .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier);
 background-color: var(--n-rail-color);
 `,[o("button-icon",`
 color: var(--n-icon-color);
 transition: color .3s var(--n-bezier);
 font-size: calc(var(--n-button-height) - 4px);
 position: absolute;
 left: 0;
 right: 0;
 top: 0;
 bottom: 0;
 display: flex;
 justify-content: center;
 align-items: center;
 line-height: 1;
 `,[q()]),o("button",`
 align-items: center; 
 top: var(--n-offset);
 left: var(--n-offset);
 height: var(--n-button-height);
 width: var(--n-button-width-pressed);
 max-width: var(--n-button-width);
 border-radius: var(--n-button-border-radius);
 background-color: var(--n-button-color);
 box-shadow: var(--n-button-box-shadow);
 box-sizing: border-box;
 cursor: inherit;
 content: "";
 position: absolute;
 transition:
 background-color .3s var(--n-bezier),
 left .3s var(--n-bezier),
 opacity .3s var(--n-bezier),
 max-width .3s var(--n-bezier),
 box-shadow .3s var(--n-bezier);
 `)]),s("active",[o("rail","background-color: var(--n-rail-color-active);")]),s("loading",[o("rail",`
 cursor: wait;
 `)]),s("disabled",[o("rail",`
 cursor: not-allowed;
 opacity: .5;
 `)])]);const Ve=["aria-checked","tabindex","onClick","onFocus","onBlur","onKeyup","onKeydown"],Fe={...Q.props,size:String,value:{type:[String,Number,Boolean],default:void 0},loading:Boolean,defaultValue:{type:[String,Number,Boolean],default:!1},disabled:{type:Boolean,default:void 0},round:{type:Boolean,default:!0},"onUpdate:value":[Function,Array],onUpdateValue:[Function,Array],checkedValue:{type:[String,Number,Boolean],default:!0},uncheckedValue:{type:[String,Number,Boolean],default:!1},railStyle:Function,rubberBand:{type:Boolean,default:!0},spinProps:Object,onChange:[Function,Array]};let F;var De=me({name:"Switch",props:Fe,slots:Object,setup(e){F===void 0&&(typeof CSS<"u"?typeof CSS.supports<"u"?F=CSS.supports("width","max(1px)"):F=!1:F=!0);const{mergedClsPrefixRef:d,inlineThemeDisabled:f,mergedComponentPropsRef:a}=pe(e),v=Q("Switch","-switch",Re,$e,e,d),g=ye(e,{mergedSize(t){var y,x;if(e.size!==void 0)return e.size;if(t)return t.mergedSize.value;const p=(x=(y=a==null?void 0:a.value)==null?void 0:y.Switch)==null?void 0:x.size;return p||"medium"}}),{mergedSizeRef:z,mergedDisabledRef:w}=g,$=E(e.defaultValue),P=Ce(e,"value"),m=_e(P,$),T=K(()=>m.value===e.checkedValue),i=E(!1),n=E(!1),R=K(()=>{const{railStyle:t}=e;if(t)return t({focused:n.value,checked:T.value})});function D(t){const{"onUpdate:value":p,onChange:y,onUpdateValue:x}=e,{nTriggerFormInput:W,nTriggerFormChange:j}=g;p&&L(p,t),x&&L(x,t),y&&L(y,t),$.value=t,W(),j()}function Z(){const{nTriggerFormFocus:t}=g;t()}function ee(){const{nTriggerFormBlur:t}=g;t()}function te(){e.loading||w.value||(m.value!==e.checkedValue?D(e.checkedValue):D(e.uncheckedValue))}function oe(){n.value=!0,Z()}function ie(){n.value=!1,ee(),i.value=!1}function ae(t){e.loading||w.value||t.key===" "&&(m.value!==e.checkedValue?D(e.checkedValue):D(e.uncheckedValue),i.value=!1)}function re(t){e.loading||w.value||t.key===" "&&(t.preventDefault(),i.value=!0)}const X=K(()=>{const{value:t}=z,{self:{opacityDisabled:p,railColor:y,railColorActive:x,buttonBoxShadow:W,buttonColor:j,boxShadowFocus:ne,loadingColor:le,textColor:se,iconColor:ce,[S("buttonHeight",t)]:u,[S("buttonWidth",t)]:de,[S("buttonWidthPressed",t)]:ue,[S("railHeight",t)]:h,[S("railWidth",t)]:V,[S("railBorderRadius",t)]:he,[S("buttonBorderRadius",t)]:be},common:{cubicBezierEaseInOut:fe}}=v.value;let M,N,U;return F?(M=`calc((${h} - ${u}) / 2)`,N=`max(${h}, ${u})`,U=`max(${V}, calc(${V} + ${u} - ${h}))`):(M=I((c(h)-c(u))/2),N=I(Math.max(c(h),c(u))),U=c(h)>c(u)?V:I(c(V)+c(u)-c(h))),{"--n-bezier":fe,"--n-button-border-radius":be,"--n-button-box-shadow":W,"--n-button-color":j,"--n-button-width":de,"--n-button-width-pressed":ue,"--n-button-height":u,"--n-height":N,"--n-offset":M,"--n-opacity-disabled":p,"--n-rail-border-radius":he,"--n-rail-color":y,"--n-rail-color-active":x,"--n-rail-height":h,"--n-rail-width":V,"--n-width":U,"--n-box-shadow-focus":ne,"--n-loading-color":le,"--n-text-color":se,"--n-icon-color":ce}}),B=f?xe("switch",K(()=>z.value[0]),X,e):void 0;return{handleClick:te,handleBlur:ie,handleFocus:oe,handleKeyup:ae,handleKeydown:re,mergedRailStyle:R,pressed:i,mergedClsPrefix:d,mergedValue:m,checked:T,mergedDisabled:w,cssVars:f?void 0:X,themeClass:B==null?void 0:B.themeClass,onRender:B==null?void 0:B.onRender}},render(){const{mergedClsPrefix:e,mergedDisabled:d,checked:f,mergedRailStyle:a,onRender:v,$slots:g}=this;v==null||v();const{checked:z,unchecked:w,icon:$,"checked-icon":P,"unchecked-icon":m}=g,T=!(O($)&&O(P)&&O(m));return b(),C("div",{role:"switch","aria-checked":f,class:r([`${e}-switch`,this.themeClass,T&&`${e}-switch--icon`,f&&`${e}-switch--active`,d&&`${e}-switch--disabled`,this.round&&`${e}-switch--round`,this.loading&&`${e}-switch--loading`,this.pressed&&`${e}-switch--pressed`,this.rubberBand&&`${e}-switch--rubber-band`]),tabindex:this.mergedDisabled?void 0:0,style:G(this.cssVars),onClick:this.handleClick,onFocus:this.handleFocus,onBlur:this.handleBlur,onKeyup:this.handleKeyup,onKeydown:this.handleKeydown},[_("div",{class:r(`${e}-switch__rail`),"aria-hidden":"true",style:G(a)},[l(()=>k(z,i=>k(w,n=>i||n?(b(),C("div",{key:4,"aria-hidden":!0,class:r(`${e}-switch__children-placeholder`)},[_("div",{class:r(`${e}-switch__rail-placeholder`)},[_("div",{class:r(`${e}-switch__button-placeholder`)},null,2),l(()=>i)],2),_("div",{class:r(`${e}-switch__rail-placeholder`)},[_("div",{class:r(`${e}-switch__button-placeholder`)},null,2),l(()=>n)],2)],2)):null))),_("div",{class:r(`${e}-switch__button`)},[l(()=>k($,i=>k(P,n=>k(m,R=>(b(),J(Be,null,{default:()=>this.loading?(b(),J(ke,Se({key:"loading",clsPrefix:e,strokeWidth:20},this.spinProps),null,16,["clsPrefix"])):this.checked&&(n||i)?(b(),C("div",{class:r(`${e}-switch__button-icon`),key:n?"checked-icon":"icon"},[l(()=>n||i)],2)):!this.checked&&(R||i)?(b(),C("div",{class:r(`${e}-switch__button-icon`),key:R?"unchecked-icon":"icon"},[l(()=>R||i)],2)):null},1024)))))),l(()=>k(z,i=>i&&(b(),C("div",{key:"checked",class:r(`${e}-switch__checked`)},[l(()=>i)],2)))),l(()=>k(w,i=>i&&(b(),C("div",{key:"unchecked",class:r(`${e}-switch__unchecked`)},[l(()=>i)],2))))],2)],6)],46,Ve)}});export{De as S};
//# sourceMappingURL=Switch-D8K9A9_o.js.map
